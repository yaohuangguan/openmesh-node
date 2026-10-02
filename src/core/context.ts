import { pipeline } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OpenMesh } from './app.js';

export type OpenMeshRequest = IncomingMessage & { body?: unknown; originalUrl?: string };
export type OpenMeshResponse = ServerResponse & { locals?: Record<string, unknown> };

export interface ContextRoute {
  paramNames: string[];
  serializer?: ((body: unknown, status?: number) => string | Buffer | Uint8Array) | null;
}

export class HttpError extends Error {
  statusCode: number;
  expose: boolean;
  code: string;
  validation?: unknown;

  constructor(statusCode: number, message?: string, options: ErrorOptions & { code?: string } = {}) {
    super(message || 'HTTP error', options);
    this.name = 'HttpError';
    if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) {
      throw new RangeError('HttpError status must be 400..599');
    }
    this.statusCode = statusCode;
    this.expose = statusCode < 500;
    this.code = options.code || 'HTTP_ERROR';
  }
}

export class Context {
  req: OpenMeshRequest;
  res: OpenMeshResponse;
  app: OpenMesh;
  path: string;
  route: ContextRoute | null;
  routePattern: string | null = null;
  private _values: string[] | null;
  private _params: Record<string, string> | null = null;
  private _query: Record<string, string | string[]> | null = null;
  private _state: Record<string, unknown> | null = null;
  private _body: unknown = undefined;

  constructor(
    req: IncomingMessage,
    res: ServerResponse,
    scope: OpenMesh,
    path: string,
    route: ContextRoute | null,
    values: string[] | null
  ) {
    this.req = req as OpenMeshRequest;
    this.res = res as OpenMeshResponse;
    this.app = scope;
    this.path = path;
    this.route = route;
    this._values = values;
  }

  get request(): OpenMeshRequest { return this.req; }
  get response(): ServerResponse { return this.res; }
  get method(): string | undefined { return this.req.method; }
  get url(): string | undefined { return this.req.url; }
  get headers(): IncomingMessage['headers'] { return this.req.headers; }
  get status(): number { return this.res.statusCode; }
  set status(value: number) {
    if (!Number.isInteger(value) || value < 100 || value > 599) throw new RangeError('Invalid response status');
    this.res.statusCode = value;
  }
  get body(): unknown { return this._body; }
  set body(value: unknown) { this._body = value; }
  get requestBody(): unknown { return this.req.body; }
  get state(): Record<string, unknown> { return this._state || (this._state = Object.create(null) as Record<string, unknown>); }

  get params(): Record<string, string> {
    if (this._params) return this._params;
    const result: Record<string, string> = Object.create(null) as Record<string, string>;
    const names = this.route?.paramNames || [];
    const values = this._values || [];
    for (let i = 0; i < names.length; i++) {
      try { result[names[i]!] = decodeURIComponent(values[i] ?? ''); }
      catch { throw new HttpError(400, 'Malformed URL parameter'); }
    }
    return (this._params = result);
  }

  get query(): Record<string, string | string[]> {
    if (this._query) return this._query;
    const result: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>;
    const url = this.req.url || '';
    const index = url.indexOf('?');
    if (index >= 0) {
      for (const [key, value] of new URLSearchParams(url.slice(index + 1))) {
        if (Object.hasOwn(result, key)) {
          const current = result[key]!;
          result[key] = Array.isArray(current) ? [...current, value] : [current, value];
        } else {
          result[key] = value;
        }
      }
    }
    return (this._query = result);
  }

  get(name: string): string | string[] | undefined { return this.req.headers[name.toLowerCase()]; }

  set(name: string, value: string | number | readonly string[]): this;
  set(headers: Record<string, string | number | readonly string[]>): this;
  set(name: string | Record<string, string | number | readonly string[]>, value?: string | number | readonly string[]): this {
    if (typeof name === 'object' && name !== null) {
      for (const [key, val] of Object.entries(name)) this.res.setHeader(key, val);
    } else if (value !== undefined) {
      this.res.setHeader(name, value);
    }
    return this;
  }

  send(value: unknown): this { this._body = value; return this; }
  json(value: unknown): this { this.res.setHeader('content-type', 'application/json; charset=utf-8'); this._body = value; return this; }
  redirect(location: string, status = 302): this { this.status = status; this.set('location', location); this.body = ''; return this; }
  throw(status: number, message?: string): never { throw new HttpError(status, message); }
}

export function respond(ctx: Context, returned: unknown): void {
  const res = ctx.res;
  if (res.writableEnded || res.destroyed || res.headersSent) return;
  let body = ctx.body !== undefined ? ctx.body : returned === ctx ? undefined : returned;

  if (res.statusCode === 204 || res.statusCode === 304) {
    res.removeHeader('content-type'); res.removeHeader('content-length'); res.removeHeader('transfer-encoding'); res.end(); return;
  }
  if (body === undefined) { if (res.statusCode === 200) res.statusCode = 204; res.end(); return; }

  if (body !== null && typeof body === 'object' && 'pipe' in body && typeof (body as NodeJS.ReadableStream).pipe === 'function') {
    if (!res.hasHeader('content-type')) res.setHeader('content-type', 'application/octet-stream');
    const stream = body as NodeJS.ReadableStream & { destroy?: () => void };
    if (ctx.method === 'HEAD') { stream.destroy?.(); res.end(); return; }
    pipeline(stream, res, () => {}); return;
  }

  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    if (!res.hasHeader('content-type')) res.setHeader('content-type', 'application/octet-stream');
  } else if (typeof body === 'string') {
    if (!res.hasHeader('content-type')) res.setHeader('content-type', 'text/plain; charset=utf-8');
  } else {
    if (!res.hasHeader('content-type')) res.setHeader('content-type', 'application/json; charset=utf-8');
    body = ctx.route?.serializer ? ctx.route.serializer(body, res.statusCode) : JSON.stringify(body);
  }

  if (typeof body !== 'string' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
    throw new TypeError('Serializer must return a string or bytes');
  }
  if (!res.hasHeader('content-length')) res.setHeader('content-length', typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength);
  res.end(ctx.method === 'HEAD' ? undefined : body);
}
