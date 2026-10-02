'use strict';
const { pipeline } = require('node:stream');
class HttpError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message || 'HTTP error', options); this.name = 'HttpError';
    if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) throw new RangeError('HttpError status must be 400..599');
    this.statusCode = statusCode; this.expose = statusCode < 500; this.code = options.code || 'HTTP_ERROR';
  }
}
class Context {
  constructor(req, res, scope, path, route, values) {
    this.req = req; this.res = res; this.app = scope; this.path = path; this.route = route;
    this._values = values; this._params = null; this._query = null; this._state = null; this._body = undefined;
  }
  get request() { return this.req; }
  get response() { return this.res; }
  get method() { return this.req.method; }
  get url() { return this.req.url; }
  get headers() { return this.req.headers; }
  get status() { return this.res.statusCode; }
  set status(value) { if (!Number.isInteger(value) || value < 100 || value > 599) throw new RangeError('Invalid response status'); this.res.statusCode = value; }
  get body() { return this._body; }
  set body(value) { this._body = value; }
  get requestBody() { return this.req.body; }
  get state() { return this._state || (this._state = Object.create(null)); }
  get params() {
    if (this._params) return this._params;
    const result = Object.create(null), names = this.route?.paramNames || [];
    for (let i = 0; i < names.length; i++) { try { result[names[i]] = decodeURIComponent(this._values[i]); } catch (_) { throw new HttpError(400, 'Malformed URL parameter'); } }
    return (this._params = result);
  }
  get query() {
    if (this._query) return this._query;
    const result = Object.create(null), index = this.req.url.indexOf('?');
    if (index >= 0) for (const [key, value] of new URLSearchParams(this.req.url.slice(index + 1))) {
      if (Object.hasOwn(result, key)) result[key] = Array.isArray(result[key]) ? [...result[key], value] : [result[key], value]; else result[key] = value;
    }
    return (this._query = result);
  }
  get(name) { return this.req.headers[name.toLowerCase()]; }
  set(name, value) { if (typeof name === 'object' && name !== null) { for (const [key, val] of Object.entries(name)) this.res.setHeader(key, val); } else this.res.setHeader(name, value); return this; }
  send(value) { this._body = value; return this; }
  json(value) { this.res.setHeader('content-type', 'application/json; charset=utf-8'); this._body = value; return this; }
  redirect(location, status = 302) { this.status = status; this.set('location', location); this.body = ''; return this; }
  throw(status, message) { throw new HttpError(status, message); }
}
function respond(ctx, returned) {
  const res = ctx.res;
  if (res.writableEnded || res.destroyed || res.headersSent) return;
  let body = ctx.body !== undefined ? ctx.body : returned === ctx ? undefined : returned;
  if (res.statusCode === 204 || res.statusCode === 304) { res.removeHeader('content-type'); res.removeHeader('content-length'); res.removeHeader('transfer-encoding'); res.end(); return; }
  if (body === undefined) { if (res.statusCode === 200) res.statusCode = 204; res.end(); return; }
  if (body !== null && typeof body.pipe === 'function') {
    if (!res.hasHeader('content-type')) res.setHeader('content-type', 'application/octet-stream');
    if (ctx.method === 'HEAD') { body.destroy(); res.end(); return; }
    pipeline(body, res, () => {}); return;
  }
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) { if (!res.hasHeader('content-type')) res.setHeader('content-type', 'application/octet-stream'); }
  else if (typeof body === 'string') { if (!res.hasHeader('content-type')) res.setHeader('content-type', 'text/plain; charset=utf-8'); }
  else { if (!res.hasHeader('content-type')) res.setHeader('content-type', 'application/json; charset=utf-8'); body = ctx.route?.serializer ? ctx.route.serializer(body, res.statusCode) : JSON.stringify(body); }
  if (typeof body !== 'string' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) throw new TypeError('Serializer must return a string or bytes');
  if (!res.hasHeader('content-length')) res.setHeader('content-length', typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength);
  res.end(ctx.method === 'HEAD' ? undefined : body);
}
module.exports = { Context, HttpError, respond };
