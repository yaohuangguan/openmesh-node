import { randomUUID, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { HttpError } from '../core/context.js';
import type { Context } from '../core/context.js';
import type { Middleware, Plugin } from '../core/app.js';

export interface RequestContextState extends Record<string, unknown> {
  requestId: string;
  service: string;
  traceparent: string;
  outboundHeaders: Record<string, string>;
}

export type PrototypeAction = 'error' | 'remove' | 'ignore';
export type FormValue = string | File;
export type FormBody = Record<string, FormValue | FormValue[]>;

const requestStorage = new AsyncLocalStorage<RequestContextState>();
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('Body limit must be a positive integer');
}

function assertPrototypeAction(action: PrototypeAction): void {
  if (!['error', 'remove', 'ignore'].includes(action)) {
    throw new TypeError('prototypeAction must be error, remove or ignore');
  }
}

function canParseBody(ctx: Context): boolean {
  return ctx.req.body === undefined && BODY_METHODS.has(ctx.method || '');
}

function contentType(ctx: Context): string {
  return String(ctx.get('content-type') || '').split(';')[0]!.trim().toLowerCase();
}

function protectPrototypeKeys(value: unknown, action: PrototypeAction): unknown {
  if (action === 'ignore' || value === null || typeof value !== 'object') return value;
  const pending: object[] = [value as object];
  while (pending.length) {
    const current = pending.pop()!;
    for (const key of Object.keys(current)) {
      const record = current as Record<string, unknown>;
      if (key === '__proto__' || key === 'constructor') {
        if (action === 'error') {
          throw new HttpError(400, 'JSON body contains forbidden prototype keys', { code: 'UNSAFE_JSON_KEY' });
        }
        delete record[key];
        continue;
      }
      const child = record[key];
      if (child && typeof child === 'object') pending.push(child as object);
    }
  }
  return value;
}

async function readPayload(ctx: Context, limit: number): Promise<Buffer> {
  const declared = Number(ctx.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    ctx.set('connection', 'close');
    ctx.req.resume();
    throw new HttpError(413, 'Request body too large');
  }

  return new Promise<Buffer>((resolve, reject) => {
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

    function aborted(): void {
      failed(new HttpError(400, 'Request aborted'));
    }

    function data(chunk: Buffer | string): void {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) {
        ctx.set('connection', 'close');
        failed(new HttpError(413, 'Request body too large'));
        ctx.req.resume();
        return;
      }
      chunks.push(bytes);
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
}

function parseJson(buffer: Buffer, prototypeAction: PrototypeAction): unknown {
  if (!buffer.length) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
  return protectPrototypeKeys(parsed, prototypeAction);
}

function appendFormValue(target: FormBody, key: string, value: FormValue): void {
  if (Object.hasOwn(target, key)) {
    const current = target[key]!;
    target[key] = Array.isArray(current) ? [...current, value] : [current, value];
  } else {
    target[key] = value;
  }
}

function parseUrlEncoded(buffer: Buffer): FormBody {
  const result = Object.create(null) as FormBody;
  if (!buffer.length) return result;
  for (const [key, value] of new URLSearchParams(buffer.toString('utf8'))) {
    appendFormValue(result, key, value);
  }
  return result;
}

function requestHeaders(ctx: Context): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(ctx.req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

async function parseMultipart(ctx: Context, buffer: Buffer): Promise<FormBody> {
  if (!buffer.length) return Object.create(null) as FormBody;
  const headers = requestHeaders(ctx);
  try {
    const request = new Request('http://openmesh.local' + (ctx.req.url || '/'), {
      method: ctx.method || 'POST',
      headers,
      body: new Uint8Array(buffer)
    });
    const form = await request.formData();
    const result = Object.create(null) as FormBody;
    for (const [key, value] of form.entries()) appendFormValue(result, key, value);
    return result;
  } catch (cause) {
    throw new HttpError(400, 'Invalid multipart body', { cause, code: 'INVALID_MULTIPART' });
  }
}

function typeMatches(type: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => {
    const normalized = pattern.toLowerCase();
    if (normalized.endsWith('/*')) return type.startsWith(normalized.slice(0, -1));
    return type === normalized;
  });
}

export function jsonBody({ limit = 1024 * 1024, prototypeAction = 'error' }: {
  limit?: number;
  prototypeAction?: PrototypeAction;
} = {}): Middleware {
  assertLimit(limit);
  assertPrototypeAction(prototypeAction);

  return async (ctx, next) => {
    const type = contentType(ctx);
    if (!canParseBody(ctx) || !(type === 'application/json' || type.endsWith('+json'))) return next();
    ctx.req.body = parseJson(await readPayload(ctx, limit), prototypeAction);
    return next();
  };
}

export function textBody({ limit = 1024 * 1024, types = ['text/*', 'application/xml', 'application/graphql'] }: {
  limit?: number;
  types?: readonly string[];
} = {}): Middleware {
  assertLimit(limit);
  if (!Array.isArray(types) || !types.length || types.some(type => typeof type !== 'string' || !type)) {
    throw new TypeError('textBody types must be a nonempty string array');
  }

  return async (ctx, next) => {
    const type = contentType(ctx);
    if (!canParseBody(ctx) || !typeMatches(type, types)) return next();
    ctx.req.body = (await readPayload(ctx, limit)).toString('utf8');
    return next();
  };
}

export function rawBody({ limit = 1024 * 1024, types }: {
  limit?: number;
  types?: readonly string[];
} = {}): Middleware {
  assertLimit(limit);
  if (types !== undefined && (!Array.isArray(types) || !types.length || types.some(type => typeof type !== 'string' || !type))) {
    throw new TypeError('rawBody types must be a nonempty string array when provided');
  }

  return async (ctx, next) => {
    const type = contentType(ctx);
    if (!canParseBody(ctx) || (types && !typeMatches(type, types))) return next();
    ctx.req.body = await readPayload(ctx, limit);
    return next();
  };
}

export function formBody({ limit = 1024 * 1024 }: { limit?: number } = {}): Middleware {
  assertLimit(limit);
  return async (ctx, next) => {
    if (!canParseBody(ctx) || contentType(ctx) !== 'application/x-www-form-urlencoded') return next();
    ctx.req.body = parseUrlEncoded(await readPayload(ctx, limit));
    return next();
  };
}

export function multipartBody({ limit = 10 * 1024 * 1024 }: { limit?: number } = {}): Middleware {
  assertLimit(limit);
  return async (ctx, next) => {
    if (!canParseBody(ctx) || contentType(ctx) !== 'multipart/form-data') return next();
    ctx.req.body = await parseMultipart(ctx, await readPayload(ctx, limit));
    return next();
  };
}

export function bodyParser({
  limit = 1024 * 1024,
  multipartLimit = 10 * 1024 * 1024,
  prototypeAction = 'error'
}: {
  limit?: number;
  multipartLimit?: number;
  prototypeAction?: PrototypeAction;
} = {}): Middleware {
  assertLimit(limit);
  assertLimit(multipartLimit);
  assertPrototypeAction(prototypeAction);

  return async (ctx, next) => {
    if (!canParseBody(ctx)) return next();
    const type = contentType(ctx);
    if (!type) return next();

    if (type === 'application/json' || type.endsWith('+json')) {
      ctx.req.body = parseJson(await readPayload(ctx, limit), prototypeAction);
    } else if (type === 'application/x-www-form-urlencoded') {
      ctx.req.body = parseUrlEncoded(await readPayload(ctx, limit));
    } else if (type === 'multipart/form-data') {
      ctx.req.body = await parseMultipart(ctx, await readPayload(ctx, multipartLimit));
    } else if (
      type.startsWith('text/') ||
      ['application/xml', 'application/graphql', 'application/javascript', 'application/sql'].includes(type)
    ) {
      ctx.req.body = (await readPayload(ctx, limit)).toString('utf8');
    } else {
      ctx.req.body = await readPayload(ctx, limit);
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
