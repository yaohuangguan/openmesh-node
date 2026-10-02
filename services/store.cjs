'use strict';
const { randomUUID } = require('node:crypto');
const { HttpError } = require('../lib/context.cjs');

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
    if (current && typeof current === 'object' && !Object.isFrozen(current)) { for (const child of Object.values(current)) pending.push(child); Object.freeze(current); }
  }
  return value;
}

class ServiceRegistry {
  constructor({ maxInstances = 10000, sweepInterval = 1000, now = Date.now } = {}) {
    if (!Number.isSafeInteger(maxInstances) || maxInstances < 1 || !Number.isSafeInteger(sweepInterval) || sweepInterval < 0 || typeof now !== 'function') throw new TypeError('Invalid registry options');
    this._instances = new Map(); this._now = now; this._max = maxInstances;
    this._timer = sweepInterval ? setInterval(() => this.sweep(), sweepInterval) : null;
    this._timer?.unref();
  }
  sweep() { const now = this._now(); for (const [key, record] of this._instances) if (record.expiresAt <= now) this._instances.delete(key); }
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
    this._instances.set(key, record); return { ...record };
  }
  _owned(service, id, leaseId) {
    name(service); name(id); this.sweep();
    const record = this._instances.get(JSON.stringify([service, id]));
    if (!record) throw new HttpError(404, 'Lease expired or instance not registered');
    if (typeof leaseId !== 'string' || record.leaseId !== leaseId) throw new HttpError(409, 'Lease belongs to another registration');
    return record;
  }
  renew(service, id, leaseId) { const record = this._owned(service, id, leaseId); record.expiresAt = this._now() + record.ttl; return { ...record }; }
  deregister(service, id, leaseId) { this._owned(service, id, leaseId); this._instances.delete(JSON.stringify([service, id])); }
  list(service) {
    name(service); this.sweep();
    return [...this._instances.values()].filter(record => record.service === service).map(({ leaseId, ...instance }) => ({ ...instance })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }
  close() { clearInterval(this._timer); this._timer = null; }
}

class ConfigStore {
  constructor({ maxNamespaces = 1000, maxBytes = 262144 } = {}) {
    if (!Number.isSafeInteger(maxNamespaces) || maxNamespaces < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Invalid configuration limits');
    this._entries = new Map(); this._max = maxNamespaces; this._maxBytes = maxBytes; this._epoch = randomUUID();
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
    this._entries.set(namespace, snapshot); return snapshot;
  }
}
module.exports = { ServiceRegistry, ConfigStore, name, freeze };
