'use strict';
const { timingSafeEqual } = require('node:crypto');
const { definePlugin, HttpError } = require('../lib/app.cjs');
const { jsonBody } = require('../plugins/index.cjs');
const { PeerPool } = require('../mesh/index.cjs');
const { RegistryAdapter, ConfigAdapter, ServiceRegistry, ConfigStore, name, freeze } = require('./store.cjs');

function validateToken(token) {
  if (typeof token !== 'string' || !/^[\x21-\x7e]{16,1024}$/.test(token)) throw new TypeError('Control-plane token must contain 16..1024 printable ASCII characters');
}
function validateAdapter(value, label, methods) {
  if (!value || methods.some(method => typeof value[method] !== 'function')) throw new TypeError(label + ' must implement ' + methods.join(', '));
  return value;
}
function closeAdapter(adapter) {
  if (typeof adapter.close !== 'function') return;
  return adapter.close();
}
async function serviceSnapshot(adapter, service) {
  const value = typeof adapter.snapshot === 'function'
    ? await adapter.snapshot(service)
    : { service, instances: await adapter.list(service) };
  if (!value || !Array.isArray(value.instances)) throw new TypeError('Registry snapshot must contain an instances array');
  return value;
}
function watchEventId(eventName, value) {
  if (eventName === 'services' && Number.isSafeInteger(value?.revision) && value.revision >= 0) return String(value.revision);
  if (eventName === 'config' && typeof value?.epoch === 'string' && Number.isSafeInteger(value?.revision) && value.revision >= 0) return value.epoch + ':' + value.revision;
  return null;
}
async function streamWatch(ctx, eventName, snapshot, subscribe, streams) {
  if (typeof subscribe !== 'function') throw new HttpError(501, 'This control-plane adapter does not support streaming watches');
  const res = ctx.res;
  streams?.add(res);
  ctx.status = 200;
  ctx.set({
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let active = true, ready = false, pending = false, queue = Promise.resolve();
  let lastSentId = typeof ctx.get('last-event-id') === 'string' ? ctx.get('last-event-id') : '';
  const send = () => {
    queue = queue.then(async () => {
      if (!active || res.destroyed || res.writableEnded) return;
      const value = await snapshot();
      const eventId = watchEventId(eventName, value);
      if (eventId && eventId === lastSentId) return;
      res.write('event: ' + eventName + '\n');
      if (eventId) res.write('id: ' + eventId + '\n');
      res.write('data: ' + JSON.stringify(value) + '\n\n');
      if (eventId) lastSentId = eventId;
    }).catch(error => {
      if (active && !res.destroyed) res.destroy(error);
    });
    return queue;
  };
  const changed = () => {
    if (!ready) { pending = true; return; }
    send();
  };
  const unsubscribe = await subscribe(changed);
  if (typeof unsubscribe !== 'function') throw new TypeError('Adapter subscribe() must return an unsubscribe function');

  await send();
  ready = true;
  if (pending) send();

  const heartbeat = setInterval(() => {
    if (active && !res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n');
  }, 15000);
  heartbeat.unref();

  return new Promise(resolve => {
    const finish = () => {
      if (!active) return;
      active = false;
      clearInterval(heartbeat);
      try { unsubscribe(); } catch (_) {}
      streams?.delete(res);
      resolve();
    };
    ctx.req.once('aborted', finish);
    res.once('close', finish);
  });
}

function controlPlane({ token, registry, config, prefix = '/_mesh' } = {}) {
  validateToken(token);
  const ownsRegistry = registry === undefined, ownsConfig = config === undefined;
  const activeRegistry = validateAdapter(registry || new ServiceRegistry(), 'registry adapter', ['register', 'renew', 'deregister', 'list']);
  const activeConfig = validateAdapter(config || new ConfigStore(), 'config adapter', ['snapshot', 'replace']);
  const secret = Buffer.from('Bearer ' + token), streams = new Set();
  return async app => {
    app.onShutdown(() => { for (const res of [...streams]) if (!res.writableEnded && !res.destroyed) res.end(); });
    if (ownsRegistry) app.onClose(() => closeAdapter(activeRegistry));
    if (ownsConfig) app.onClose(() => closeAdapter(activeConfig));
    app.register(async scope => {
      scope.use(async (ctx, next) => {
        const supplied = ctx.get('authorization');
        const bytes = typeof supplied === 'string' && supplied.length <= 4096 ? Buffer.from(supplied) : Buffer.alloc(0);
        if (bytes.length !== secret.length || !timingSafeEqual(bytes, secret)) ctx.throw(401, 'Unauthorized');
        return next();
      });
      scope.use(jsonBody({ limit: 300000 }));
      const path = '/services/:service/instances/:id';
      scope.post(path, async ctx => { ctx.status = 201; return activeRegistry.register(ctx.params.service, ctx.params.id, ctx.requestBody); });
      scope.put(path + '/lease', ctx => activeRegistry.renew(ctx.params.service, ctx.params.id, ctx.requestBody?.leaseId));
      scope.delete(path, async ctx => { await activeRegistry.deregister(ctx.params.service, ctx.params.id, ctx.requestBody?.leaseId); ctx.status = 204; });
      scope.get('/services/:service', async ctx => {
        const cursor = ctx.query.cursor;
        if (cursor !== undefined) name(cursor);
        const snapshot = await serviceSnapshot(activeRegistry, ctx.params.service);
        const filtered = snapshot.instances.filter(instance => !cursor || instance.id > cursor);
        const instances = filtered.slice(0, 100);
        return {
          service: ctx.params.service,
          revision: Number.isSafeInteger(snapshot.revision) ? snapshot.revision : undefined,
          instances,
          nextCursor: filtered.length > 100 ? instances.at(-1).id : null
        };
      });
      scope.get('/watch/services/:service', ctx => {
        name(ctx.params.service);
        return streamWatch(
          ctx,
          'services',
          () => serviceSnapshot(activeRegistry, ctx.params.service),
          typeof activeRegistry.subscribe === 'function' ? listener => activeRegistry.subscribe(ctx.params.service, listener) : null,
          streams
        );
      });
      scope.get('/config/:namespace', ctx => activeConfig.snapshot(ctx.params.namespace));
      scope.put('/config/:namespace', ctx => activeConfig.replace(ctx.params.namespace, ctx.requestBody?.values, ctx.requestBody?.expectedRevision, ctx.requestBody?.expectedEpoch));
      scope.get('/watch/config/:namespace', ctx => {
        name(ctx.params.namespace);
        return streamWatch(
          ctx,
          'config',
          () => activeConfig.snapshot(ctx.params.namespace),
          typeof activeConfig.subscribe === 'function' ? listener => activeConfig.subscribe(ctx.params.namespace, listener) : null,
          streams
        );
      });
    }, { prefix });
  };
}

class Registration {
  constructor(client, record, options, requestedAt = performance.now()) {
    this.client = client; this.record = freeze(record); this.options = options;
    this.lastError = null; this._validUntil = requestedAt + record.ttl; this._stopped = false; this._lost = false; this._timer = null; this._pending = null; this._abort = new AbortController();
    this._schedule();
  }
  get healthy() { return !this._stopped && !this._lost && this._validUntil > performance.now(); }
  _schedule() { clearTimeout(this._timer); if (!this._stopped && !this._lost) { this._timer = setTimeout(() => { this._pending = this._renew(); }, Math.max(100, Math.floor(this.record.ttl / 3))); this._timer.unref(); } }
  async _renew() {
    const requestedAt = performance.now();
    try {
      let record;
      try { record = await this.client._call('PUT', this.client._instancePath(this.record.service, this.record.id) + '/lease', { leaseId: this.record.leaseId }, this._abort.signal); }
      catch (error) {
        if (error.statusCode !== 404 || this._stopped) throw error;
        record = await this.client._call('POST', this.client._instancePath(this.record.service, this.record.id), this.options, this._abort.signal);
      }
      if (!this._stopped) { this.record = freeze(record); this._validUntil = requestedAt + record.ttl; this.lastError = null; }
    } catch (error) {
      if (!this._stopped) { this.lastError = error; if (error.statusCode === 409) this._lost = true; try { this.options.onError?.(error); } catch (_) {} }
    } finally { this._schedule(); }
  }
  async stop() {
    if (this._stopPromise) return this._stopPromise;
    this._stopped = true; clearTimeout(this._timer); this._abort.abort();
    this._stopPromise = (async () => {
      await this._pending;
      try { await this.client._call('DELETE', this.client._instancePath(this.record.service, this.record.id), { leaseId: this.record.leaseId }); }
      catch (error) { if (![404, 409].includes(error.statusCode)) throw error; }
      finally { this.client._registrations.delete(this); }
    })();
    return this._stopPromise;
  }
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(done, ms);
    timer.unref();
    function done() { signal?.removeEventListener('abort', aborted); resolve(); }
    function aborted() { clearTimeout(timer); reject(signal.reason); }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}
async function parseSSE(response, onData) {
  if (!response.ok) {
    let message = 'Control-plane watch failed';
    try { const data = await response.json(); if (data?.error) message = data.error; } catch (_) {}
    throw new HttpError(response.status, message);
  }
  if (!response.body) throw new Error('Control-plane watch returned no body');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      const lines = block.split('\n');
      const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      const idLine = lines.find(line => line.startsWith('id:'));
      const eventId = idLine ? idLine.slice(3).trimStart() : null;
      if (data) await onData(JSON.parse(data), eventId);
    }
  }
}

class ConfigWatcher {
  constructor(client, snapshot, { interval = 1000, reconnectDelay = 250, transport = 'stream', onUpdate = () => {}, onError = () => {}, validate = () => {} } = {}) {
    if (!Number.isSafeInteger(interval) || interval < 50 || !Number.isSafeInteger(reconnectDelay) || reconnectDelay < 50 || !['stream', 'poll'].includes(transport) || typeof onUpdate !== 'function' || typeof onError !== 'function' || typeof validate !== 'function') throw new TypeError('Invalid configuration watcher');
    this.client = client; this.snapshot = freeze(snapshot); this.lastError = null; this._interval = interval; this._reconnectDelay = reconnectDelay; this._transport = transport; this._onUpdate = onUpdate; this._onError = onError; this._validate = validate; this._stopped = false; this._abort = new AbortController(); this._timer = null;
    this._lastEventId = snapshot.epoch + ':' + snapshot.revision;
    this._check(snapshot.values);
    if (transport === 'stream') this._task = this._stream();
    else this._schedule();
  }
  _check(values) { const result = this._validate(values); if (result && typeof result.then === 'function') { result.catch(() => {}); throw new TypeError('Configuration validation must be synchronous'); } }
  get(key, fallback) { return Object.hasOwn(this.snapshot.values, key) ? this.snapshot.values[key] : fallback; }
  _apply(next) {
    if (this._stopped || (next.revision === this.snapshot.revision && next.epoch === this.snapshot.epoch)) return;
    this._check(next.values);
    const previous = this.snapshot;
    this.snapshot = freeze(next);
    this.lastError = null;
    this._onUpdate(this.snapshot, previous);
  }
  _report(error) {
    if (this._stopped) return;
    this.lastError = error;
    try { this._onError(error); } catch (_) {}
  }
  _schedule() { clearTimeout(this._timer); if (!this._stopped) { this._timer = setTimeout(() => this._refresh(), this._interval); this._timer.unref(); } }
  async _refresh() {
    try { this._apply(await this.client.getConfig(this.snapshot.namespace, { signal: this._abort.signal })); }
    catch (error) { this._report(error); }
    finally { if (this._transport === 'poll') this._schedule(); }
  }
  async _stream() {
    while (!this._stopped) {
      try {
        await this.client._watch('/watch/config/' + name(this.snapshot.namespace), this._abort.signal, (value, eventId) => {
          if (eventId) this._lastEventId = eventId;
          this._apply(value);
        }, this._lastEventId);
        if (!this._stopped) throw new Error('Control-plane config watch ended');
      } catch (error) {
        if (this._stopped || this._abort.signal.aborted) return;
        this._report(error);
        if ([404, 501].includes(error.statusCode)) { this._transport = 'poll'; this._schedule(); return; }
        try { await delay(this._reconnectDelay, this._abort.signal); } catch (_) { return; }
      }
    }
  }
  stop() { if (this._stopped) return; this._stopped = true; clearTimeout(this._timer); this._abort.abort(); this.client._watchers.delete(this); }
}

function sameInstances(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id || a[i].url !== b[i].url || a[i].ttl !== b[i].ttl || JSON.stringify(a[i].metadata) !== JSON.stringify(b[i].metadata)) return false;
  return true;
}
class ServiceWatcher {
  constructor(client, service, instances, { interval = 1000, reconnectDelay = 250, transport = 'stream', onUpdate = () => {}, onError = () => {} } = {}) {
    if (!Number.isSafeInteger(interval) || interval < 50 || !Number.isSafeInteger(reconnectDelay) || reconnectDelay < 50 || !['stream', 'poll'].includes(transport) || typeof onUpdate !== 'function' || typeof onError !== 'function') throw new TypeError('Invalid service watcher');
    this.client = client; this.service = name(service); this.instances = freeze(instances.map(instance => ({ ...instance }))); this.lastError = null; this._interval = interval; this._reconnectDelay = reconnectDelay; this._transport = transport; this._onUpdate = onUpdate; this._onError = onError; this._stopped = false; this._abort = new AbortController(); this._timer = null; this._lastEventId = null;
    if (transport === 'stream') this._task = this._stream(); else this._schedule();
  }
  _apply(value) {
    const next = Array.isArray(value) ? value : value?.instances;
    if (!Array.isArray(next)) throw new TypeError('Service watch payload must contain instances');
    const frozen = freeze(next.map(instance => ({ ...instance })));
    if (this._stopped || sameInstances(this.instances, frozen)) return;
    const previous = this.instances;
    this.instances = frozen;
    this.lastError = null;
    this._onUpdate(this.instances, previous);
  }
  _report(error) {
    if (this._stopped) return;
    this.lastError = error;
    try { this._onError(error); } catch (_) {}
  }
  _schedule() { clearTimeout(this._timer); if (!this._stopped) { this._timer = setTimeout(() => this._refresh(), this._interval); this._timer.unref(); } }
  async _refresh() {
    try { this._apply(await this.client.discover(this.service, { signal: this._abort.signal })); }
    catch (error) { this._report(error); }
    finally { if (this._transport === 'poll') this._schedule(); }
  }
  async _stream() {
    while (!this._stopped) {
      try {
        await this.client._watch('/watch/services/' + this.service, this._abort.signal, (value, eventId) => {
          if (eventId) this._lastEventId = eventId;
          this._apply(value);
        }, this._lastEventId);
        if (!this._stopped) throw new Error('Control-plane service watch ended');
      } catch (error) {
        if (this._stopped || this._abort.signal.aborted) return;
        this._report(error);
        if ([404, 501].includes(error.statusCode)) { this._transport = 'poll'; this._schedule(); return; }
        try { await delay(this._reconnectDelay, this._abort.signal); } catch (_) { return; }
      }
    }
  }
  stop() { if (this._stopped) return; this._stopped = true; clearTimeout(this._timer); this._abort.abort(); this.client._serviceWatchers.delete(this); }
}

class ControlClient {
  constructor({ url, token, timeout = 2000 } = {}) {
    validateToken(token);
    this._pool = new PeerPool({ peers: [{ id: 'control-plane', url }], timeout, retries: 0, cooldown: 1000, maxResponseBytes: 2 * 1024 * 1024 });
    this._url = url.replace(/\/$/, ''); this._token = token; this._registrations = new Set(); this._watchers = new Set(); this._serviceWatchers = new Set(); this._closing = false;
  }
  _instancePath(service, id) { return '/services/' + name(service) + '/instances/' + name(id); }
  async _call(method, path, body, signal) {
    const response = await this._pool.request(path, { method, body, signal, headers: { authorization: 'Bearer ' + this._token } });
    if (response.statusCode >= 400) throw new HttpError(response.statusCode, response.json().error || 'Control-plane request failed');
    return response.statusCode === 204 ? undefined : response.json();
  }
  async _watch(path, signal, onData, lastEventId) {
    const headers = { authorization: 'Bearer ' + this._token, accept: 'text/event-stream' };
    if (lastEventId) headers['last-event-id'] = lastEventId;
    const response = await fetch(this._url + path, { headers, signal, redirect: 'error' });
    return parseSSE(response, onData);
  }
  async register(service, { id, url, ttl = 30000, metadata = {}, onError } = {}) {
    if (this._closing) throw new Error('Control client is closing');
    if (onError !== undefined && typeof onError !== 'function') throw new TypeError('onError must be a function');
    const options = { url, ttl, metadata };
    const requestedAt = performance.now();
    const record = await this._call('POST', this._instancePath(service, id), options);
    if (this._closing) { await this._call('DELETE', this._instancePath(service, id), { leaseId: record.leaseId }); throw new Error('Control client is closing'); }
    const registration = new Registration(this, record, { ...options, metadata: record.metadata, onError }, requestedAt); this._registrations.add(registration); return registration;
  }
  async discover(service, { signal } = {}) {
    service = name(service);
    const deadline = AbortSignal.timeout(this._pool.timeout);
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
    for (let attempt = 0; attempt < 3; attempt++) {
      const instances = new Map(); let cursor = null, revision;
      let changed = false;
      for (let page = 0; page < 100; page++) {
        const result = await this._call('GET', '/services/' + service + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), undefined, bounded);
        if (Number.isSafeInteger(result.revision)) {
          if (revision === undefined) revision = result.revision;
          else if (revision !== result.revision) { changed = true; break; }
        }
        for (const instance of result.instances) instances.set(instance.id, instance);
        if (!result.nextCursor) return [...instances.values()];
        if (cursor && result.nextCursor <= cursor) throw new Error('Discovery cursor did not advance');
        cursor = result.nextCursor;
      }
      if (!changed) throw new Error('Discovery exceeded 100 pages; narrow the service membership');
    }
    throw new Error('Service membership changed repeatedly during discovery');
  }
  getConfig(namespace, { signal } = {}) { return this._call('GET', '/config/' + name(namespace), undefined, signal); }
  setConfig(namespace, values, { expectedRevision, expectedEpoch, signal } = {}) { return this._call('PUT', '/config/' + name(namespace), { values, expectedRevision, expectedEpoch }, signal); }
  async watchConfig(namespace, options = {}) {
    if (this._closing) throw new Error('Control client is closing');
    const snapshot = await this.getConfig(namespace);
    if (this._closing) throw new Error('Control client is closing');
    const watcher = new ConfigWatcher(this, snapshot, options); this._watchers.add(watcher); return watcher;
  }
  async watchService(service, options = {}) {
    if (this._closing) throw new Error('Control client is closing');
    const instances = await this.discover(service);
    if (this._closing) throw new Error('Control client is closing');
    const watcher = new ServiceWatcher(this, service, instances, options); this._serviceWatchers.add(watcher); return watcher;
  }
  close() {
    if (!this._closePromise) {
      this._closing = true;
      for (const watcher of this._watchers) watcher.stop();
      for (const watcher of this._serviceWatchers) watcher.stop();
      this._closePromise = Promise.allSettled([...this._registrations].map(registration => registration.stop())).then(results => {
        this._pool.close(); const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, 'Some registrations could not be removed; their leases will expire');
      });
    }
    return this._closePromise;
  }
}

function serviceRegistration({ client, service, id, url, ttl = 30000, metadata = {}, onError } = {}) {
  if (!(client instanceof ControlClient) || (typeof url !== 'string' && typeof url !== 'function')) throw new TypeError('Service registration needs a ControlClient and an advertised URL or address callback');
  name(service); name(id);
  return definePlugin(app => {
    app.decorate('registration', null);
    app.onListen(async (scope, address) => { scope.registration = await client.register(service, { id, url: typeof url === 'function' ? url(address) : url, ttl, metadata, onError }); });
    app.onClose(() => app.registration?.stop());
  }, { name: 'service-registration', global: true });
}
module.exports = { RegistryAdapter, ConfigAdapter, ServiceRegistry, ConfigStore, controlPlane, ControlClient, Registration, ConfigWatcher, ServiceWatcher, serviceRegistration };
