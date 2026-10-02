'use strict';
const { timingSafeEqual } = require('node:crypto');
const { definePlugin, HttpError } = require('../lib/app.cjs');
const { jsonBody } = require('../plugins/index.cjs');
const { PeerPool } = require('../mesh/index.cjs');
const { ServiceRegistry, ConfigStore, name, freeze } = require('./store.cjs');
function validateToken(token) {
  if (typeof token !== 'string' || !/^[\x21-\x7e]{16,1024}$/.test(token)) throw new TypeError('Control-plane token must contain 16..1024 printable ASCII characters');
}

function controlPlane({ token, registry, config = new ConfigStore(), prefix = '/_mesh' } = {}) {
  validateToken(token);
  const secret = Buffer.from('Bearer ' + token), owned = !registry;
  return async app => {
    const activeRegistry = registry || new ServiceRegistry();
    if (owned) app.onClose(() => activeRegistry.close());
    app.register(async scope => {
      scope.use(async (ctx, next) => {
        const supplied = ctx.get('authorization');
        const bytes = typeof supplied === 'string' && supplied.length <= 4096 ? Buffer.from(supplied) : Buffer.alloc(0);
        if (bytes.length !== secret.length || !timingSafeEqual(bytes, secret)) ctx.throw(401, 'Unauthorized');
        return next();
      });
      scope.use(jsonBody({ limit: 300000 }));
      const path = '/services/:service/instances/:id';
      scope.post(path, ctx => { ctx.status = 201; return activeRegistry.register(ctx.params.service, ctx.params.id, ctx.requestBody); });
      scope.put(path + '/lease', ctx => activeRegistry.renew(ctx.params.service, ctx.params.id, ctx.requestBody?.leaseId));
      scope.delete(path, ctx => { activeRegistry.deregister(ctx.params.service, ctx.params.id, ctx.requestBody?.leaseId); ctx.status = 204; });
      scope.get('/services/:service', ctx => {
        const cursor = ctx.query.cursor;
        if (cursor !== undefined) name(cursor);
        const records = activeRegistry.list(ctx.params.service).filter(instance => !cursor || instance.id > cursor);
        const instances = records.slice(0, 100);
        return { instances, nextCursor: records.length > 100 ? instances.at(-1).id : null };
      });
      scope.get('/config/:namespace', ctx => config.snapshot(ctx.params.namespace));
      scope.put('/config/:namespace', ctx => config.replace(ctx.params.namespace, ctx.requestBody?.values, ctx.requestBody?.expectedRevision, ctx.requestBody?.expectedEpoch));
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

class ConfigWatcher {
  constructor(client, snapshot, { interval = 1000, onUpdate = () => {}, onError = () => {}, validate = () => {} } = {}) {
    if (!Number.isSafeInteger(interval) || interval < 50 || typeof onUpdate !== 'function' || typeof onError !== 'function' || typeof validate !== 'function') throw new TypeError('Invalid configuration watcher');
    this.client = client; this.snapshot = freeze(snapshot); this.lastError = null; this._interval = interval; this._onUpdate = onUpdate; this._onError = onError; this._validate = validate; this._stopped = false; this._abort = new AbortController(); this._timer = null;
    this._check(snapshot.values);
    this._schedule();
  }
  _check(values) { const result = this._validate(values); if (result && typeof result.then === 'function') { result.catch(() => {}); throw new TypeError('Configuration validation must be synchronous'); } }
  get(key, fallback) { return Object.hasOwn(this.snapshot.values, key) ? this.snapshot.values[key] : fallback; }
  _schedule() { clearTimeout(this._timer); if (!this._stopped) { this._timer = setTimeout(() => this._refresh(), this._interval); this._timer.unref(); } }
  async _refresh() {
    try {
      const next = await this.client.getConfig(this.snapshot.namespace, { signal: this._abort.signal });
      if (!this._stopped) {
        if (next.revision !== this.snapshot.revision || next.epoch !== this.snapshot.epoch) { this._check(next.values); const previous = this.snapshot; this.snapshot = freeze(next); this._onUpdate(this.snapshot, previous); }
        this.lastError = null;
      }
    } catch (error) { if (!this._stopped) { this.lastError = error; try { this._onError(error); } catch (_) {} } }
    finally { this._schedule(); }
  }
  stop() { if (this._stopped) return; this._stopped = true; clearTimeout(this._timer); this._abort.abort(); this.client._watchers.delete(this); }
}

class ControlClient {
  constructor({ url, token, timeout = 2000 } = {}) {
    validateToken(token);
    this._pool = new PeerPool({ peers: [{ id: 'control-plane', url }], timeout, retries: 0, cooldown: 1000, maxResponseBytes: 2 * 1024 * 1024 });
    this._token = token; this._registrations = new Set(); this._watchers = new Set(); this._closing = false;
  }
  _instancePath(service, id) { return '/services/' + name(service) + '/instances/' + name(id); }
  async _call(method, path, body, signal) {
    const response = await this._pool.request(path, { method, body, signal, headers: { authorization: 'Bearer ' + this._token } });
    if (response.statusCode >= 400) throw new HttpError(response.statusCode, response.json().error || 'Control-plane request failed');
    return response.statusCode === 204 ? undefined : response.json();
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
    const deadline = AbortSignal.timeout(this._pool.timeout);
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const instances = new Map(); let cursor = null;
    for (let page = 0; page < 100; page++) {
      const result = await this._call('GET', '/services/' + name(service) + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), undefined, bounded);
      for (const instance of result.instances) instances.set(instance.id, instance);
      if (!result.nextCursor) return [...instances.values()];
      if (cursor && result.nextCursor <= cursor) throw new Error('Discovery cursor did not advance');
      cursor = result.nextCursor;
    }
    throw new Error('Discovery exceeded 100 pages; narrow the service membership');
  }
  getConfig(namespace, { signal } = {}) { return this._call('GET', '/config/' + name(namespace), undefined, signal); }
  setConfig(namespace, values, { expectedRevision, expectedEpoch, signal } = {}) { return this._call('PUT', '/config/' + name(namespace), { values, expectedRevision, expectedEpoch }, signal); }
  async watchConfig(namespace, options = {}) {
    if (this._closing) throw new Error('Control client is closing');
    const snapshot = await this.getConfig(namespace);
    if (this._closing) throw new Error('Control client is closing');
    const watcher = new ConfigWatcher(this, snapshot, options); this._watchers.add(watcher); return watcher;
  }
  close() {
    if (!this._closePromise) {
      this._closing = true;
      for (const watcher of this._watchers) watcher.stop();
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
module.exports = { ServiceRegistry, ConfigStore, controlPlane, ControlClient, Registration, ConfigWatcher, serviceRegistration };
