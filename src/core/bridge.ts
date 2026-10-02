import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context, OpenMeshRequest, OpenMeshResponse } from './context.js';
import type { Middleware } from './app.js';

export type ExpressMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void
) => unknown;

export function invokeMiddleware(fn: ExpressMiddleware, ctx: Context, prefix = ''): Promise<void> {
  const req = ctx.req as OpenMeshRequest;
  const res = ctx.res as OpenMeshResponse;
  const original = req.url || '/';

  if (prefix) {
    const suffix = original.slice(prefix.length);
    req.url = !suffix || suffix.startsWith('?') ? '/' + suffix : suffix;
  }
  if (req.originalUrl === undefined) req.originalUrl = original;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    function settle(error?: unknown): void {
      if (settled) return;
      settled = true;
      req.url = original;
      res.off('finish', ended);
      res.off('close', ended);
      error ? reject(error) : resolve();
    }
    function ended(): void { settle(); }

    res.once('finish', ended);
    res.once('close', ended);
    try {
      const returned = fn(req, res, error => settle(error));
      if (returned && typeof (returned as PromiseLike<unknown>).then === 'function') Promise.resolve(returned).catch(settle);
      if (res.writableEnded || res.destroyed) settle();
    } catch (error) {
      settle(error);
    }
  });
}

export function expressMiddleware(fn: ExpressMiddleware): Middleware {
  if (typeof fn !== 'function' || fn.length === 4) {
    throw new TypeError('useExpress expects normal (req, res, next) middleware; mount an Express app for its error middleware');
  }
  return async (ctx, next) => {
    const req = ctx.req;
    const res = ctx.res;
    if (req.originalUrl === undefined) req.originalUrl = req.url;
    if (res.locals === undefined) res.locals = Object.create(null) as Record<string, unknown>;
    await invokeMiddleware(fn, ctx);
    if (!res.writableEnded && !res.destroyed) return next();
  };
}
