'use strict';
function invokeMiddleware(fn, ctx, prefix = '') {
  const req = ctx.req, res = ctx.res, original = req.url;
  if (prefix) { const suffix = original.slice(prefix.length); req.url = !suffix || suffix.startsWith('?') ? '/' + suffix : suffix; }
  if (req.originalUrl === undefined) req.originalUrl = original;
  return new Promise((resolve, reject) => {
    let settled = false;
    function settle(error) { if (settled) return; settled = true; req.url = original; res.off('finish', ended); res.off('close', ended); error ? reject(error) : resolve(); }
    function ended() { settle(); }
    res.once('finish', ended); res.once('close', ended);
    try {
      const returned = fn(req, res, error => settle(error));
      if (returned && typeof returned.then === 'function') returned.catch(settle);
      if (res.writableEnded || res.destroyed) settle();
    } catch (error) { settle(error); }
  });
}
function expressMiddleware(fn) {
  if (typeof fn !== 'function' || fn.length === 4) throw new TypeError('useExpress expects normal (req, res, next) middleware; mount an Express app for its error middleware');
  return async (ctx, next) => {
    const req = ctx.req, res = ctx.res;
    if (req.originalUrl === undefined) req.originalUrl = req.url;
    if (res.locals === undefined) res.locals = Object.create(null);
    await invokeMiddleware(fn, ctx);
    if (!res.writableEnded && !res.destroyed) return next();
  };
}
module.exports = { invokeMiddleware, expressMiddleware };
