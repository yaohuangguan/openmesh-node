'use strict';
const { randomUUID } = require('node:crypto');
const { HttpError } = require('../lib/context.cjs');

class RegistryAdapter {
  register() { throw new Error('RegistryAdapter.register() is not implemented'); }
  renew() { throw new Error('RegistryAdapter.renew() is not implemented'); }
  deregister() { throw new Error('RegistryAdapter.deregister() is not implemented'); }
  list() { throw new Error('RegistryAdapter.list() is not implemented'); }
  snapshot(service) {
    const instances = this.list(service);
    return instances && typeof instances.then === 'function'
      ? instances.then(value => ({ service, instances: value }))
      : { service, instances };
  }
  subscribe() { throw new Error('RegistryAdapter.subscribe() is not implemented'); }
  close() {}
}

class ConfigAdapter {
  snapshot() { throw new Error('ConfigAdapter.snapshot() is not implemented'); }
  replace() { throw new Error('ConfigAdapter.replace() is not implemented'); }
  subscribe() { throw new Error('ConfigAdapter.subscribe() is not implemented'); }
  close() {}
}

function name(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new HttpError(400, 'Invalid service, instance or namespace name');
  return value;
}
function duration(value) {
  if (!Number.isSafeInteger(value) || value < 1000 || value > 3600000) throw new HttpError(400, 'Lease TTL must be 1000..3600000 milliseconds');
  return value;
}
function jsonObject(value, limit) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Expected a JSON object');
  let text;
  try { text = JSON.stringify(value); } catch (_) { throw new HttpError(400, 'Invalid JSON object'); }
  if (Buffer.byteLength(text) > limit) throw new HttpError(413, 'Object exceeds size limit');
  return freeze(JSON.parse(text));
}
function freeze(value) {
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (current && typeof current === 'object' && !Object.isFrozen(current)) {
      for (const child of Object.values(current)) pending.push(child);
      Object.freeze(current);
    }
  }
  return value;
}
function subscribe(map, key, listener) {
  if (typeof listener !== 'function') throw new TypeError('Subscription listener must be a function');
  let listeners = map.get(key);
  if (!listeners) map.set(key, (listeners = new Set()));
  listeners.add(listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    listeners.delete(listener);
    if (!listeners.size) map.delete(key);
  };
}
function notify(map, key, value) {
  const listeners = map.get(key);
  if (!listeners) return;
  for (const listener of [...listeners]) {
    try { listener(value); } catch (_) {}
  }
}

class ServiceRegistry extends RegistryAdapter {
  constructor({ maxInstances = 10000, sweepInterval = 1000, now = Date.now } = {}) {
    super();
    if (!Number.isSafeInteger(maxInstances) || maxInstances < 1 || !Number.isSafeInteger(sweepInterval) || sweepInterval < 0 || typeof now !== 'function') throw new TypeError('Invalid registry options');
    this._instances = new Map(); this._now = now; this._max = maxInstances; this._subscriptions = new Map(); this._revisions = new Map();
    this._timer = sweepInterval ? setInterval(() => this.sweep(), sweepInterval) : null;
    this._timer?.unref();
  }
  _changed(service, reason) {
    const revision = (this._revisions.get(service) || 0) + 1;
    this._revisions.set(service, revision);
    notify(this._subscriptions, service, Object.freeze({ service, reason, revision }));
  }
  sweep() {
    const now = this._now(), changed = new Set();
    for (const [key, record] of this._instances) {
      if (record.expiresAt <= now) { this._instances.delete(key); changed.add(record.service); }
    }
    for (const service of changed) this._changed(service, 'expired');
  }
  register(service, id, { url, ttl = 30000, metadata = {} } = {}) {
    name(service); name(id); duration(ttl);
    if (typeof url !== 'string' || url.length > 2048) throw new HttpError(400, 'Instance URL must be a string of at most 2048 characters');
    let address; try { address = new URL(url); } catch (_) { throw new HttpError(400, 'Invalid instance URL'); }
    if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.hash || address.search) throw new HttpError(400, 'Instance URL must be HTTP(S) without credentials, query or fragment');
    metadata = jsonObject(metadata, 8192);
    this.sweep(); const key = JSON.stringify([service, id]);
    if (this._instances.has(key)) throw new HttpError(409, 'Instance ID already has an active lease');
    if (this._instances.size >= this._max) throw new HttpError(503, 'Registry capacity reached');
    const record = { service, id, url: address.origin + address.pathname.replace(/\/$/, ''), metadata, ttl, leaseId: randomUUID(), expiresAt: this._now() + ttl };
    this._instances.set(key, record); this._changed(service, 'registered'); return { ...record };
  }
  _owned(service, id, leaseId) {
    name(service); name(id); this.sweep();
    const record = this._instances.get(JSON.stringify([service, id]));
    if (!record) throw new HttpError(404, 'Lease expired or instance not registered');
    if (typeof leaseId !== 'string' || record.leaseId !== leaseId) throw new HttpError(409, 'Lease belongs to another registration');
    return record;
  }
  renew(service, id, leaseId) {
    const record = this._owned(service, id, leaseId);
    record.expiresAt = this._now() + record.ttl;
    return { ...record };
  }
  deregister(service, id, leaseId) {
    this._owned(service, id, leaseId);
    this._instances.delete(JSON.stringify([service, id]));
    this._changed(service, 'deregistered');
  }
  list(service) {
    name(service); this.sweep();
    return [...this._instances.values()].filter(record => record.service === service).map(({ leaseId, ...instance }) => ({ ...instance })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }
  snapshot(service) {
    const instances = this.list(service);
    return Object.freeze({ service, revision: this._revisions.get(service) || 0, instances: freeze(instances) });
  }
  subscribe(service, listener) { name(service); return subscribe(this._subscriptions, service, listener); }
  close() { clearInterval(this._timer); this._timer = null; this._subscriptions.clear(); this._revisions.clear(); }
}

class ConfigStore extends ConfigAdapter {
  constructor({ maxNamespaces = 1000, maxBytes = 262144 } = {}) {
    super();
    if (!Number.isSafeInteger(maxNamespaces) || maxNamespaces < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Invalid configuration limits');
    this._entries = new Map(); this._max = maxNamespaces; this._maxBytes = maxBytes; this._epoch = randomUUID(); this._subscriptions = new Map();
  }
  snapshot(namespace) { name(namespace); return this._entries.get(namespace) || Object.freeze({ namespace, epoch: this._epoch, revision: 0, values: Object.freeze({}) }); }
  replace(namespace, values, expectedRevision, expectedEpoch) {
    name(namespace);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new HttpError(400, 'An expectedRevision is required');
    if (typeof expectedEpoch !== 'string' || !expectedEpoch) throw new HttpError(400, 'An expectedEpoch is required');
    const current = this.snapshot(namespace);
    if (current.revision !== expectedRevision || current.epoch !== expectedEpoch) throw new HttpError(409, 'Configuration revision or epoch conflict');
    if (!this._entries.has(namespace) && this._entries.size >= this._max) throw new HttpError(503, 'Configuration capacity reached');
    const snapshot = Object.freeze({ namespace, epoch: this._epoch, revision: current.revision + 1, values: jsonObject(values, this._maxBytes) });
    this._entries.set(namespace, snapshot);
    notify(this._subscriptions, namespace, snapshot);
    return snapshot;
  }
  subscribe(namespace, listener) { name(namespace); return subscribe(this._subscriptions, namespace, listener); }
  close() { this._subscriptions.clear(); }
}

module.exports = { RegistryAdapter, ConfigAdapter, ServiceRegistry, ConfigStore, name, freeze };
