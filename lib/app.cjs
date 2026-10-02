'use strict';
const http = require('node:http');
const { Router } = require('./router.cjs');
const { compose } = require('./compose.cjs');
const { Context, HttpError, respond } = require('./context.cjs');
const { invokeMiddleware, expressMiddleware } = require('./bridge.cjs');
const PLUGIN = Symbol.for('openmesh.plugin');
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE'];
function definePlugin(fn, metadata = {}) {
  if (typeof fn !== 'function') throw new TypeError('Plugin must be a function');
  if (metadata.name !== undefined && (typeof metadata.name !== 'string' || !metadata.name)) throw new TypeError('Plugin name must be a nonempty string');
  Object.defineProperty(fn, PLUGIN, { value: Object.freeze({ ...metadata }), configurable: true }); return fn;
}
function prefixPath(parent, prefix) {
  if (typeof prefix !== 'string' || (prefix && (!prefix.startsWith('/') || /[?#:*]/.test(prefix)))) throw new TypeError('Prefix must be a literal path beginning with /');
  return parent + (prefix === '/' ? '' : prefix.replace(/\/$/, ''));
}
function inherited(scope, key) { const chain = []; for (let current = scope; current; current = current._parent) chain.unshift(...current[key]); return chain; }
function validationValue(ctx, part) {
  if (part === 'body') return ctx.requestBody;
  if (part === 'querystring') return ctx.query;
  if (part === 'params') return ctx.params;
  if (part === 'headers') return ctx.headers;
}
async function validateRoute(ctx, validators) {
  for (const [part, validate] of validators) {
    let result;
    try { result = await validate(validationValue(ctx, part)); }
    catch (error) { throw new HttpError(400, 'Validation failed for ' + part, { cause: error, code: 'VALIDATION_ERROR' }); }
    if (result === false || (result && typeof result === 'object' && result.error)) {
      const cause = result && typeof result === 'object' ? result.error : undefined;
      const error = new HttpError(400, 'Validation failed for ' + part, { cause, code: 'VALIDATION_ERROR' });
      if (validate.errors !== undefined) error.validation = validate.errors;
      throw error;
    }
  }
}
function compileRouteSchema(route) {
  const schema = route.schema;
  if (!schema) return [];
  const validators = [];
  for (const part of ['body', 'querystring', 'params', 'headers']) {
    if (schema[part] === undefined) continue;
    const compiler = route.scope._validatorCompiler;
    if (typeof compiler !== 'function') throw new Error('Route schema requires a validator compiler: ' + route.method + ' ' + route.path);
    const validate = compiler({ schema: schema[part], method: route.method, url: route.path, httpPart: part });
    if (typeof validate !== 'function') throw new TypeError('Validator compiler must return a function');
    validators.push([part, validate]);
  }
  if (schema.response !== undefined) {
    if (!schema.response || typeof schema.response !== 'object' || Array.isArray(schema.response)) throw new TypeError('schema.response must be an object');
    const compiler = route.scope._serializerCompiler;
    if (typeof compiler !== 'function') throw new Error('schema.response requires a serializer compiler: ' + route.method + ' ' + route.path);
    const serializers = new Map();
    for (const [status, responseSchema] of Object.entries(schema.response)) {
      const key = status.toLowerCase();
      if (!/^(?:[1-5]\d\d|[1-5]xx|default)$/.test(key)) throw new TypeError('Invalid response schema status: ' + status);
      const serialize = compiler({ schema: responseSchema, method: route.method, url: route.path, httpStatus: key });
      if (typeof serialize !== 'function') throw new TypeError('Serializer compiler must return a function');
      serializers.set(key, serialize);
    }
    route.responseSerializers = serializers;
  }
  return validators;
}
function responseSerializer(route, status) {
  const serializers = route?.responseSerializers;
  if (!serializers) return route?.serializer;
  return serializers.get(String(status)) || serializers.get(Math.floor(status / 100) + 'xx') || serializers.get('default');
}
class OpenMesh {
  constructor(options = {}) {
    this._root = this; this._parent = null; this._prefix = ''; this._middleware = []; this._pending = []; this._names = new Set();
    this._routes = []; this._mounts = []; this._shutdownHooks = []; this._closeHooks = []; this._listenHooks = []; this._phase = 'configuring'; this._readyPromise = null; this._closePromise = null;
    this._router = new Router(); this._notFoundHandlers = []; this._errorHandler = null; this._sockets = new Set(); this._server = null;
    this._options = { pluginTimeout: 10000, shutdownTimeout: 5000, server: {}, serverLimits: {}, ...options };
    for (const key of ['pluginTimeout', 'shutdownTimeout']) if (!Number.isFinite(this._options[key]) || this._options[key] < 0) throw new TypeError(key + ' must be a nonnegative finite number');
    this._serverLimits = { requestTimeout: 120000, headersTimeout: 10000, keepAliveTimeout: 5000, maxHeadersCount: 100, ...this._options.serverLimits };
    for (const key of ['requestTimeout', 'headersTimeout', 'keepAliveTimeout', 'maxHeadersCount']) if (!Number.isSafeInteger(this._serverLimits[key]) || this._serverLimits[key] < 0) throw new TypeError(key + ' must be a nonnegative integer');
    if (this._serverLimits.requestTimeout && this._serverLimits.headersTimeout > this._serverLimits.requestTimeout) throw new RangeError('headersTimeout cannot exceed requestTimeout');
    this._validatorCompiler = options.validatorCompiler ?? null; this._serializerCompiler = options.serializerCompiler ?? null;
    if (this._validatorCompiler !== null && typeof this._validatorCompiler !== 'function') throw new TypeError('validatorCompiler must be a function');
    if (this._serializerCompiler !== null && typeof this._serializerCompiler !== 'function') throw new TypeError('serializerCompiler must be a function');
    this._listener = (req, res) => this._dispatch(req, res);
  }
  get server() { return this._root._server; }
  get phase() { return this._root._phase; }
  get prefix() { return this._prefix; }
  get version() { return '0.2.0'; }
  _assertMutable() { if (!['configuring', 'booting'].includes(this._root._phase)) throw new Error('Configure routes and plugins before ready() or listen()'); }
  use(fn) { this._assertMutable(); if (typeof fn !== 'function') throw new TypeError('Middleware must be a function'); this._middleware.push(fn); return this; }
  useExpress(fn) { return this.use(expressMiddleware(fn)); }
  route(method, path, options, handler) {
    this._assertMutable(); if (typeof options === 'function') { handler = options; options = {}; }
    options ||= {}; if (typeof handler !== 'function') throw new TypeError('Route handler must be a function');
    if (typeof path !== 'string' || !path.startsWith('/')) throw new TypeError('Route path must be a string beginning with /');
    if (typeof method !== 'string' || !/^(\*|[A-Z]+)$/.test(method)) throw new TypeError('HTTP method must be uppercase or *');
    if (options.serializer !== undefined && typeof options.serializer !== 'function') throw new TypeError('Serializer must be a function');
    if (options.schema !== undefined && (!options.schema || typeof options.schema !== 'object' || Array.isArray(options.schema))) throw new TypeError('Route schema must be an object');
    if (options.serializer && options.schema?.response) throw new TypeError('Use either route serializer or schema.response, not both');
    const middleware = options.middleware === undefined ? [] : Array.isArray(options.middleware) ? options.middleware : [options.middleware];
    if (middleware.some(fn => typeof fn !== 'function')) throw new TypeError('Route middleware must contain functions');
    const route = { method, path: this._prefix + path, scope: this, handler, serializer: options.serializer, schema: options.schema || null, responseSerializers: null, middleware, run: null, paramNames: [] };
    this._root._router.add(method, route.path, route); this._root._routes.push(route); return this;
  }
  all(path, options, handler) { return this.route('*', path, options, handler); }
  register(plugin, options = {}) {
    this._assertMutable(); if (typeof plugin !== 'function') throw new TypeError('Plugin must be a function');
    this._pending.push({ plugin, options }); return this;
  }
  setValidatorCompiler(compiler) { this._assertMutable(); if (typeof compiler !== 'function') throw new TypeError('Validator compiler must be a function'); this._validatorCompiler = compiler; return this; }
  setSerializerCompiler(compiler) { this._assertMutable(); if (typeof compiler !== 'function') throw new TypeError('Serializer compiler must be a function'); this._serializerCompiler = compiler; return this; }
  decorate(name, value) {
    this._assertMutable();
    if (typeof name !== 'string' || !name || name.startsWith('_') || name in OpenMesh.prototype || ['__proto__', 'prototype', 'constructor'].includes(name) || Object.hasOwn(this, name)) throw new Error('Duplicate or reserved decoration: ' + name);
    Object.defineProperty(this, name, { value, writable: true, enumerable: true, configurable: true }); return this;
  }
  hasPlugin(name) { for (let scope = this; scope; scope = scope._parent) if (scope._names.has(name)) return true; return false; }
  onShutdown(fn) { this._assertMutable(); if (typeof fn !== 'function') throw new TypeError('Shutdown hook must be a function'); this._root._shutdownHooks.push(() => fn(this)); return this; }
  onClose(fn) { this._assertMutable(); if (typeof fn !== 'function') throw new TypeError('Close hook must be a function'); this._root._closeHooks.push(() => fn(this)); return this; }
  onListen(fn) { this._assertMutable(); if (typeof fn !== 'function') throw new TypeError('Listen hook must be a function'); this._root._listenHooks.push(address => fn(this, address)); return this; }
  setErrorHandler(fn) { this._assertMutable(); if (typeof fn !== 'function') throw new TypeError('Error handler must be a function'); this._errorHandler = fn; return this; }
  setNotFoundHandler(fn) {
    this._assertMutable(); if (typeof fn !== 'function') throw new TypeError('Not-found handler must be a function');
    const root = this._root, existing = root._notFoundHandlers.find(entry => entry.scope === this);
    if (existing) existing.handler = fn; else root._notFoundHandlers.push({ scope: this, prefix: this._prefix, handler: fn, run: null });
    return this;
  }
  mount(prefix, handler, options = {}) {
    this._assertMutable(); if (typeof handler !== 'function') throw new TypeError('Mount expects a Node/Express (req, res, next) handler');
    const fullPrefix = prefixPath(this._prefix, prefix);
    if (this._root._mounts.some(m => m.prefix === fullPrefix)) throw new Error('Duplicate mount: ' + fullPrefix);
    this._root._mounts.push({ prefix: fullPrefix, handler, scope: this, run: null });
    if (options.close) this.onClose(options.close); return this;
  }
  fastify(prefix, plugin, options = {}) {
    this._assertMutable(); if (typeof plugin !== 'function') throw new TypeError('Fastify bridge expects a plugin function');
    return this.register(async scope => {
      let factory;
      try { factory = (await import('fastify')).default; } catch (error) { throw new Error('Install optional peer dependency: npm install fastify@5', { cause: error }); }
      const host = factory(options.server || {});
      scope.onClose(() => host.close());
      host.register(plugin, options.plugin || {}); await host.ready();
      scope.mount(prefix, (req, res) => host.routing(req, res));
    }, { prefix: '' });
  }
  async _boot() {
    for (let index = 0; index < this._pending.length; index++) {
      const { plugin, options } = this._pending[index], metadata = plugin[PLUGIN] || {};
      for (const dependency of metadata.dependencies || []) if (!this.hasPlugin(dependency)) throw new Error('Missing plugin dependency: ' + dependency);
      if (metadata.name && this._names.has(metadata.name)) throw new Error('Duplicate plugin: ' + metadata.name);
      if (metadata.global && options.prefix) throw new Error('Global plugins cannot have a route prefix');
      const scope = metadata.global ? this : Object.create(this);
      if (scope !== this) { scope._parent = this; scope._prefix = prefixPath(this._prefix, options.prefix || ''); scope._middleware = []; scope._pending = []; scope._names = new Set(); }
      await new Promise((resolve, reject) => {
        let finished = false;
        const timer = this._root._options.pluginTimeout ? setTimeout(() => done(new Error('Plugin startup timed out: ' + (metadata.name || plugin.name || 'anonymous'))), this._root._options.pluginTimeout) : null;
        function done(error) { if (finished) return; finished = true; if (timer) clearTimeout(timer); error ? reject(error) : resolve(); }
        try {
          const returned = plugin(scope, options, done);
          if (returned && typeof returned.then === 'function') { if (plugin.length >= 3) { returned.catch(() => {}); done(new Error('Plugin cannot mix a Promise with a done callback')); } else returned.then(() => done(), done); }
          else if (plugin.length < 3) done();
        } catch (error) { done(error); }
      });
      if (metadata.name) scope._names.add(metadata.name);
      if (scope !== this) await scope._boot();
    }
  }
  _compile() {
    for (const route of this._routes) {
      const middleware = [...inherited(route.scope, '_middleware'), ...route.middleware], validators = compileRouteSchema(route);
      if (route.responseSerializers) route.serializer = (body, status) => { const serialize = responseSerializer(route, status); return serialize ? serialize(body) : JSON.stringify(body); };
      const invoke = validators.length ? async ctx => { await validateRoute(ctx, validators); return route.handler(ctx); } : route.handler;
      const handler = ctx => { const value = invoke(ctx); if (value && typeof value.then === 'function') return value.then(result => { if (ctx.body === undefined && result !== ctx) ctx.body = result; }); if (ctx.body === undefined && value !== ctx) ctx.body = value; return value; };
      route.run = middleware.length ? compose(middleware, handler) : invoke;
    }
    for (const mount of this._mounts) { const middleware = inherited(mount.scope, '_middleware'); const handler = ctx => invokeMiddleware(mount.handler, ctx, mount.prefix).then(() => { if (!ctx.res.writableEnded && !ctx.res.destroyed) throw new HttpError(404, 'Mounted application did not handle the request'); }); mount.run = middleware.length ? compose(middleware, handler) : handler; }
    for (const entry of this._notFoundHandlers) {
      const middleware = inherited(entry.scope, '_middleware');
      const handler = ctx => { const value = entry.handler(ctx); if (value && typeof value.then === 'function') return value.then(result => { if (ctx.body === undefined && result !== ctx) ctx.body = result; }); if (ctx.body === undefined && value !== ctx) ctx.body = value; return value; };
      entry.run = middleware.length ? compose(middleware, handler) : handler;
    }
    this._mounts.sort((a, b) => b.prefix.length - a.prefix.length);
    this._notFoundHandlers.sort((a, b) => b.prefix.length - a.prefix.length);
    this._fallback = this._middleware.length ? compose(this._middleware, ctx => this._fallbackHandler(ctx)) : ctx => this._fallbackHandler(ctx);
  }
  ready() {
    const root = this._root;
    if (this !== root && root._phase === 'booting') return Promise.reject(new Error('Do not call ready() from a plugin; return from the plugin instead'));
    if (root._readyPromise) return root._readyPromise;
    if (['closing', 'closed', 'failed'].includes(root._phase)) return Promise.reject(new Error('Application is ' + root._phase));
    root._phase = 'booting';
    root._readyPromise = root._boot().then(() => { root._compile(); root._phase = 'ready'; return root; }, async error => { root._phase = 'failed'; try { await root._runCloseHooks(); } catch (cleanup) { error = new AggregateError([error, cleanup], 'Startup failed and cleanup failed'); } throw error; });
    return root._readyPromise;
  }
  callback() {
    const root = this._root;
    if (root._phase === 'configuring' && !root._pending.length) { root._compile(); root._phase = 'ready'; root._readyPromise = Promise.resolve(root); }
    if (!['ready', 'listening'].includes(root._phase)) throw new Error('await app.ready() before callback() when using plugins');
    return root._listener;
  }
  async listen(options = {}) {
    const root = this._root; await root.ready();
    if (root._server || root._phase !== 'ready') throw new Error('Application has already started or closed');
    if (typeof options === 'number') options = { port: options };
    root._server = http.createServer(root._options.server, root._listener);
    root._server.requestTimeout = root._serverLimits.requestTimeout;
    root._server.headersTimeout = root._serverLimits.headersTimeout;
    root._server.keepAliveTimeout = root._serverLimits.keepAliveTimeout;
    root._server.maxHeadersCount = root._serverLimits.maxHeadersCount;
    root._server.on('connection', socket => { root._sockets.add(socket); socket.once('close', () => root._sockets.delete(socket)); });
    try {
      await new Promise((resolve, reject) => { const failed = error => { root._server.off('listening', started); reject(error); }; const started = () => { root._server.off('error', failed); resolve(); }; root._server.once('error', failed); root._server.once('listening', started); root._server.listen({ port: 0, host: '127.0.0.1', ...options }); });
      root._phase = 'listening';
      const address = root._server.address();
      root._listenHooksPromise = (async () => { for (const hook of root._listenHooks) await hook(address); })();
      await root._listenHooksPromise;
      return address;
    } catch (error) {
      if (root._server?.listening) {
        try { await root.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Listen hook failed and cleanup failed'); }
      } else root._server = null;
      throw error;
    }
  }
  async _runShutdownHooks() {
    const errors = [];
    for (const hook of this._shutdownHooks.splice(0).reverse()) { try { await hook(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'Shutdown hooks failed');
  }
  async _runCloseHooks() {
    const errors = [];
    for (const hook of this._closeHooks.splice(0).reverse()) { try { await hook(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'Close hooks failed');
  }
  close(options = {}) {
    const root = this._root;
    if (root._closePromise) return root._closePromise;
    const timeout = options.timeout ?? root._options.shutdownTimeout;
    if (!Number.isFinite(timeout) || timeout < 0) return Promise.reject(new TypeError('Shutdown timeout must be finite and nonnegative'));
    root._closePromise = (async () => {
      if (root._phase === 'booting') { try { await root._readyPromise; } catch (_) {} }
      root._phase = 'closing';
      if (root._listenHooksPromise) { try { await root._listenHooksPromise; } catch (_) {} }
      const errors = [];
      try { await root._runShutdownHooks(); } catch (error) { errors.push(error); }
      try {
        if (root._server?.listening) await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { for (const socket of root._sockets) socket.destroy(); }, timeout);
          root._server.close(error => { clearTimeout(timer); error ? reject(error) : resolve(); }); root._server.closeIdleConnections();
        });
      } catch (error) { errors.push(error); }
      try { await root._runCloseHooks(); } catch (error) { errors.push(error); }
      root._phase = 'closed';
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Application shutdown failed');
    })(); return root._closePromise;
  }
  _fallbackHandler(ctx) {
    const allowed = this._router.allowed(ctx.path);
    if (allowed.length) { ctx.status = 405; ctx.set('allow', allowed.join(', ')); return ctx.send({ error: 'Method Not Allowed' }); }
    ctx.status = 404; return ctx.send({ error: 'Not Found' });
  }
  _dispatch(req, res) {
    if (this._phase === 'closing' || this._phase === 'closed' || this._phase === 'failed') { res.writeHead(503, { connection: 'close', 'content-type': 'application/json' }); res.end('{"error":"Service Unavailable"}'); return; }
    const url = req.url || '/', queryIndex = url.indexOf('?'), path = queryIndex < 0 ? url : url.slice(0, queryIndex);
    let ctx;
    try {
      const match = this._router.find(path, req.method);
      let route = match?.route;
      if (!route) route = this._mounts.find(m => !m.prefix || path === m.prefix || path.startsWith(m.prefix + '/'));
      let notFound = null;
      if (!route && !this._router.allowed(path).length) notFound = this._notFoundHandlers.find(entry => !entry.prefix || path === entry.prefix || path.startsWith(entry.prefix + '/')) || null;
      ctx = new Context(req, res, route?.scope || notFound?.scope || this, path, route, match?.values);
      const result = route ? route.run(ctx) : notFound ? notFound.run(ctx) : this._fallback(ctx);
      if (result && typeof result.then === 'function') result.then(value => { try { respond(ctx, value); } catch (error) { this._handleError(error, ctx); } }, error => this._handleError(error, ctx));
      else respond(ctx, result);
    } catch (error) { this._handleError(error, ctx || new Context(req, res, this, path, null, null)); }
  }
  _handleError(error, ctx) {
    if (!(error instanceof Error)) error = new Error('Request failed', { cause: error });
    if (ctx.res.writableEnded || ctx.res.destroyed) return;
    if (ctx.res.headersSent) { ctx.res.destroy(error); return; }
    ctx.body = undefined;
    const handler = ctx.app._errorHandler;
    if (handler) {
      try { const result = handler(error, ctx); if (result && typeof result.then === 'function') { result.then(value => { try { respond(ctx, value); } catch (failure) { this._defaultError(failure, ctx); } }, failure => this._defaultError(failure, ctx)); } else respond(ctx, result); return; } catch (failure) { error = failure; }
    }
    this._defaultError(error, ctx);
  }
  _defaultError(error, ctx) {
    if (!(error instanceof Error)) error = new Error('Request failed', { cause: error });
    if (ctx.res.writableEnded || ctx.res.destroyed) return;
    const status = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500;
    ctx.res.statusCode = status; ctx.res.removeHeader('content-length'); ctx.res.removeHeader('content-encoding'); ctx.res.setHeader('content-type', 'application/json; charset=utf-8');
    ctx.res.end(JSON.stringify({ error: status < 500 && error.expose !== false ? error.message : 'Internal Server Error' }));
  }
}
for (const method of METHODS) OpenMesh.prototype[method.toLowerCase()] = function (path, options, handler) { return this.route(method, path, options, handler); };
module.exports = { OpenMesh, Context, HttpError, definePlugin };
