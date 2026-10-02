'use strict';
const http = require('node:http');
const https = require('node:https');
const { createHash } = require('node:crypto');
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
class PeerError extends Error {
  constructor(message, code, options = {}) { super(message, options); this.name = 'PeerError'; this.code = code; if (options.peer) this.peer = options.peer; if (options.statusCode) this.statusCode = options.statusCode; }
}
class PeerResponse {
  constructor(peer, response) { this.peer = peer; this.statusCode = response.statusCode; this.headers = response.headers; this.body = response.body; }
  text() { return this.body.toString('utf8'); }
  json() { return JSON.parse(this.text()); }
}
function validatePeers(peers) {
  if (!Array.isArray(peers)) throw new TypeError('Peers must be an array');
  const ids = new Set();
  return peers.map(peer => {
    if (!peer || typeof peer.id !== 'string' || !peer.id || ids.has(peer.id)) throw new TypeError('Peers need unique nonempty ids');
    const url = new URL(peer.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError('Peer URL must be a trusted HTTP(S) origin or path prefix without credentials, query or fragment');
    ids.add(peer.id); return Object.freeze({ id: peer.id, url: url.origin + url.pathname.replace(/\/$/, '') });
  });
}
function targetURL(peer, path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\#\r\n]/.test(path)) throw new TypeError('RPC path must be an absolute local path, not a URL');
  return new URL(peer.url + path);
}
function raceAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
class PeerPool {
  constructor(options = {}) {
    this.timeout = options.timeout ?? 2000; this.retries = options.retries ?? 1; this.failureThreshold = options.failureThreshold ?? 3; this.cooldown = options.cooldown ?? 10000; this.maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
    for (const name of ['timeout', 'failureThreshold', 'cooldown', 'maxResponseBytes']) if (!Number.isSafeInteger(this[name]) || this[name] <= 0) throw new TypeError(name + ' must be a positive integer');
    if (!Number.isSafeInteger(this.retries) || this.retries < 0) throw new TypeError('Retries must be a nonnegative integer');
    const maxSockets = options.maxSockets ?? 32;
    if (!Number.isSafeInteger(maxSockets) || maxSockets <= 0) throw new TypeError('maxSockets must be a positive integer');
    if (options.transport !== undefined && typeof options.transport !== 'function') throw new TypeError('Transport must be a function');
    this._http = new http.Agent({ keepAlive: true, maxSockets, maxTotalSockets: 256 });
    this._https = new https.Agent({ keepAlive: true, maxSockets, maxTotalSockets: 256 });
    this._transport = options.transport || (request => this._send(request));
    this._states = new Map(); this._peers = []; this._cache = new Map(); this._active = new Set(); this._counter = 0; this._closed = false; this._watch = null;
    this.updatePeers(options.peers || []);
  }
  updatePeers(peers) {
    if (this._closed) throw new PeerError('Peer pool is closed', 'POOL_CLOSED');
    const next = validatePeers(peers), states = new Map();
    for (const peer of next) { const previous = this._states.get(peer.id); states.set(peer.id, previous?.url === peer.url ? previous : { url: peer.url, failures: 0, unavailableUntil: 0, probing: false, attempts: 0 }); }
    this._states = states; this._peers = next; this._cache.clear(); return this;
  }
  get peers() { return this._peers.slice(); }
  rank(key) {
    key = String(key); let ranked = this._cache.get(key);
    if (!ranked) {
      ranked = this._peers.map(peer => ({ peer, score: createHash('sha256').update(JSON.stringify([key, peer.id])).digest().readBigUInt64BE() })).sort((a, b) => a.score > b.score ? -1 : a.score < b.score ? 1 : a.peer.id.localeCompare(b.peer.id)).map(x => x.peer);
      if (this._cache.size >= 1024) this._cache.delete(this._cache.keys().next().value);
      this._cache.set(key, ranked);
    }
    return ranked.slice();
  }
  stats() { const now = Date.now(); return this._peers.map(peer => { const state = this._states.get(peer.id); return { ...peer, failures: state.failures, attempts: state.attempts, circuit: state.unavailableUntil > now ? 'open' : state.failures >= this.failureThreshold ? 'half-open' : 'closed', probing: state.probing }; }); }
  _claim(peer) {
    const state = this._states.get(peer.id);
    if (!state || state.url !== peer.url || state.unavailableUntil > Date.now() || state.probing) return null;
    if (state.failures >= this.failureThreshold) state.probing = true;
    state.attempts++; return state;
  }
  _success(state) { state.failures = 0; state.unavailableUntil = 0; state.probing = false; }
  _failure(state) { state.failures++; state.probing = false; if (state.failures >= this.failureThreshold) state.unavailableUntil = Date.now() + this.cooldown; }
  _send({ url, method, headers, body, signal, maxResponseBytes }) {
    return new Promise((resolve, reject) => {
      const secure = url.protocol === 'https:';
      const req = (secure ? https : http).request(url, { method, headers, signal, agent: secure ? this._https : this._http }, res => {
        const chunks = []; let size = 0; let stopped = false;
        res.on('data', chunk => {
          if (stopped) return;
          size += chunk.length;
          if (size > maxResponseBytes) {
            stopped = true;
            reject(new PeerError('Peer response exceeds size limit', 'RESPONSE_TOO_LARGE'));
            res.destroy();
          } else chunks.push(chunk);
        });
        res.once('end', () => { if (!stopped) resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks, size) }); });
        res.once('error', reject); res.once('aborted', () => reject(new PeerError('Peer response aborted', 'RESPONSE_ABORTED')));
      });
      req.once('error', reject); req.end(body);
    });
  }
  request(path, options = {}) { return this._request(path, options); }
  async _request(path, options = {}, onlyPeer = null) {
    if (this._closed) throw new PeerError('Peer pool is closed', 'POOL_CLOSED');
    const method = (options.method || 'GET').toUpperCase(), headers = { ...options.headers };
    let body = options.body;
    if (body !== undefined && body !== null && !Buffer.isBuffer(body) && !(body instanceof Uint8Array) && typeof body !== 'string') { body = JSON.stringify(body); if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json'; }
    const retries = options.retries ?? this.retries, timeout = options.timeout ?? this.timeout;
    if (!Number.isSafeInteger(retries) || retries < 0 || !Number.isSafeInteger(timeout) || timeout <= 0) throw new TypeError('Retries and timeout must be valid integers');
    if (options.retryUnsafe && (typeof options.idempotencyKey !== 'string' || !options.idempotencyKey)) throw new TypeError('retryUnsafe requires an idempotencyKey and server-side deduplication');
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    const attempts = SAFE_METHODS.has(method) || options.retryUnsafe ? retries + 1 : 1;
    const candidates = onlyPeer ? [onlyPeer] : this.rank(options.key ?? String(this._counter++));
    if (!candidates.length) throw new PeerError('No peers available', 'NO_PEERS');
    for (const peer of candidates) targetURL(peer, path);
    const controller = new AbortController(); this._active.add(controller);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new PeerError('Peer request deadline exceeded', 'DEADLINE_EXCEEDED')), timeout);
    let count = 0, lastError;
    try {
      if (signal.aborted) throw signal.reason;
      for (const peer of candidates) {
        const state = this._claim(peer); if (!state) continue;
        count++;
        try {
          const response = await raceAbort(this._transport({ peer, url: targetURL(peer, path), method, headers, body, signal, maxResponseBytes: this.maxResponseBytes }), signal);
          if (response.statusCode >= 500) throw new PeerError('Peer returned HTTP ' + response.statusCode, 'REMOTE_HTTP_ERROR', { peer, statusCode: response.statusCode });
          this._success(state); return new PeerResponse(peer, response);
        } catch (error) {
          if (options.signal?.aborted || this._closed) { state.probing = false; throw signal.reason || error; }
          this._failure(state); lastError = error;
          if (signal.aborted) throw signal.reason;
          if (count >= attempts) break;
        }
      }
      throw lastError || new PeerError('All peer circuits are open', 'NO_HEALTHY_PEERS');
    } finally { clearTimeout(timer); this._active.delete(controller); }
  }
  async json(path, options) { return (await this.request(path, options)).json(); }
  async broadcast(path, options = {}) {
    const peers = this.peers, concurrency = options.concurrency ?? 8;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new TypeError('Broadcast concurrency must be 1..64');
    const results = new Array(peers.length); let index = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, peers.length) }, async () => {
      while (index < peers.length) { const slot = index++, peer = peers[slot]; try { results[slot] = { peer, status: 'fulfilled', value: await this._request(path, { ...options, retries: 0 }, peer) }; } catch (reason) { results[slot] = { peer, status: 'rejected', reason }; } }
    })); return results;
  }
  async discover(provider) {
    if (typeof provider !== 'function') throw new TypeError('Discovery provider must be a function');
    const peers = await provider(); this.updatePeers(peers); return this.peers;
  }
  watch(provider, { interval = 10000, onError = () => {} } = {}) {
    if (this._closed) throw new PeerError('Peer pool is closed', 'POOL_CLOSED');
    if (typeof provider !== 'function' || typeof onError !== 'function' || !Number.isSafeInteger(interval) || interval <= 0) throw new TypeError('Invalid discovery watcher');
    this.stopDiscovery(); const watcher = { timer: null, stopped: false }; this._watch = watcher;
    const refresh = async () => {
      if (watcher.stopped || this._closed) return;
      try { const peers = await provider(); if (!watcher.stopped && !this._closed) this.updatePeers(peers); } catch (error) { try { onError(error); } catch (_) {} }
      if (!watcher.stopped && !this._closed) { watcher.timer = setTimeout(refresh, interval); watcher.timer.unref(); }
    };
    refresh(); return this;
  }
  stopDiscovery() { if (this._watch) { this._watch.stopped = true; clearTimeout(this._watch.timer); this._watch = null; } return this; }
  close() { if (this._closed) return; this._closed = true; this.stopDiscovery(); for (const controller of this._active) controller.abort(new PeerError('Peer pool is closed', 'POOL_CLOSED')); this._http.destroy(); this._https.destroy(); }
}
module.exports = { PeerPool, PeerError, PeerResponse };
