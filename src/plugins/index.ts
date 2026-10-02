import { randomUUID, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { HttpError } from '../core/context.js';
import type { Middleware, Plugin } from '../core/app.js';

export interface RequestContextState extends Record<string, unknown> {
  requestId: string;
  service: string;
  traceparent: string;
  outboundHeaders: Record<string, string>;
}

const requestStorage = new AsyncLocalStorage<RequestContextState>();
type PrototypeAction = 'error' | 'remove' | 'ignore';

function protectPrototypeKeys(value: unknown, action: PrototypeAction): unknown {
  if (action === 'ignore' || value === null || typeof value !== 'object') return value;
  const pending: object[] = [value as object];
  while (pending.length) {
    const current = pending.pop()!;
    for (const key of Object.keys(current)) {
      const record = current as Record<string, unknown>;
      if (key === '__proto__' || key === 'constructor') {
        if (action === 'error') throw new HttpError(400, 'JSON body contains forbidden prototype keys', { code: 'UNSAFE_JSON_KEY' });
        delete record[key];
        continue;
      }
      const child = record[key];
      if (child && typeof child === 'object') pending.push(child as object);
    }
  }
  return value;
}

export function jsonBody({ limit = 1024 * 1024, prototypeAction = 'error' }: {
  limit?: number;
  prototypeAction?: PrototypeAction;
} = {}): Middleware {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('Body limit must be a positive integer');
  if (!['error', 'remove', 'ignore'].includes(prototypeAction)) throw new TypeError('prototypeAction must be error, remove or ignore');

  return async (ctx, next) => {
    const type = String(ctx.get('content-type') || '').split(';')[0]!.trim().toLowerCase();
    if (
      ctx.req.body !== undefined ||
      !['POST', 'PUT', 'PATCH', 'DELETE'].includes(ctx.method || '') ||
      !(type === 'application/json' || type.endsWith('+json'))
    ) return next();

    const declared = Number(ctx.get('content-length'));
    if (declared > limit) {
      ctx.set('connection', 'close');
      ctx.req.resume();
      throw new HttpError(413, 'Request body too large');
    }

    const body = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      function clean(): void {
        ctx.req.off('data', data);
        ctx.req.off('end', ended);
        ctx.req.off('error', failed);
        ctx.req.off('aborted', aborted);
      }
      function failed(error: unknown): void {
        if (settled) return;
        settled = true;
        clean();
        reject(error);
      }
      function aborted(): void { failed(new HttpError(400, 'Request aborted')); }
      function data(chunk: Buffer | string): void {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > limit) {
          ctx.set('connection', 'close');
          failed(new HttpError(413, 'Request body too large'));
          ctx.req.resume();
        } else {
          chunks.push(bytes);
        }
      }
      function ended(): void {
        if (settled) return;
        settled = true;
        clean();
        resolve(Buffer.concat(chunks, size));
      }
      ctx.req.on('data', data);
      ctx.req.once('end', ended);
      ctx.req.once('error', failed);
      ctx.req.once('aborted', aborted);
    });

    if (!body.length) {
      ctx.req.body = undefined;
    } else {
      let parsed: unknown;
      try { parsed = JSON.parse(body.toString('utf8')); }
      catch { throw new HttpError(400, 'Invalid JSON body'); }
      ctx.req.body = protectPrototypeKeys(parsed, prototypeAction);
    }
    return next();
  };
}

export function requestContext({ service = 'openmesh', requestIdHeader = 'x-request-id' }: {
  service?: string;
  requestIdHeader?: string;
} = {}): Middleware {
  requestIdHeader = requestIdHeader.toLowerCase();
  return async (ctx, next) => {
    const supplied = ctx.get(requestIdHeader);
    const requestId = typeof supplied === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : randomUUID();
    const incoming = ctx.get('traceparent');
    const validTrace = typeof incoming === 'string' && /^00-(?!0{32}-)[\da-f]{32}-(?!0{16}-)[\da-f]{16}-[\da-f]{2}$/.test(incoming);
    const traceId = validTrace ? incoming.slice(3, 35) : randomBytes(16).toString('hex');
    const flags = validTrace ? incoming.slice(-2) : '01';
    const traceparent = `00-${traceId}-${randomBytes(8).toString('hex')}-${flags}`;
    const outboundHeaders = { [requestIdHeader]: requestId, traceparent };

    const state = ctx.state as RequestContextState;
    state.requestId = requestId;
    state.service = service;
    state.traceparent = traceparent;
    state.outboundHeaders = outboundHeaders;
    ctx.set(requestIdHeader, requestId);
    ctx.set('traceparent', traceparent);
    return requestStorage.run(state, () => next());
  };
}

export function currentRequestContext(): RequestContextState | null {
  return requestStorage.getStore() || null;
}

export function health({ ready = () => true, livePath = '/health/live', readyPath = '/health/ready' }: {
  ready?: () => boolean | Promise<boolean>;
  livePath?: string;
  readyPath?: string;
} = {}): Plugin {
  return async app => {
    app.get(livePath, () => ({ status: 'live' }));
    app.get(readyPath, async ctx => {
      const available = await ready();
      ctx.status = available ? 200 : 503;
      return { status: available ? 'ready' : 'not-ready' };
    });
  };
}
