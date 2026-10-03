import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo, ListenOptions } from 'node:net';
import type { ServerOptions } from 'node:http';
import type { ServerOptions as HttpsServerOptions } from 'node:https';
import { Router, type Routable } from './router.js';
import { compose } from './compose.js';
import { Context, HttpError, prepareResponse, sendPrepared } from './context.js';
import { invokeMiddleware, expressMiddleware, type ExpressMiddleware } from './bridge.js';

const PLUGIN = Symbol.for('openmesh.plugin');
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE'] as const;

export type Next = () => Promise<unknown>;
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
      options?: { readonly libraryOptions?: Record<string, unknown> }
    ) =>
      | { readonly value: Output; readonly issues?: undefined }
      | { readonly issues: ReadonlyArray<{ readonly message: string; readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> }> }
      | Promise<
          | { readonly value: Output; readonly issues?: undefined }
          | { readonly issues: ReadonlyArray<{ readonly message: string; readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> }> }
        >;
    readonly types?: {
      readonly input: Input;
      readonly output: Output;
    };
  };
}

export type InferStandardSchema<Schema, Fallback = unknown> =
  Schema extends StandardSchemaV1<any, infer Output> ? Output : Fallback;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type SegmentParams<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
    ? { [K in Param | keyof SegmentParams<`/${Rest}`>]: string }
    : Path extends `${string}:${infer Param}`
      ? { [K in Param]: string }
      : Path extends `${string}*/${infer Rest}`
        ? { '*': string } & SegmentParams<`/${Rest}`>
        : Path extends `${string}*`
          ? { '*': string }
          : {};

export type PathParams<Path extends string> = Simplify<SegmentParams<Path>>;

export interface HttpReply<Status extends number = number, Body = unknown> {
  readonly status: Status;
  readonly body: Body;
  readonly headers?: Readonly<Record<string, string | number | readonly string[]>>;
}

export interface TypedRouteOptions {
  body?: StandardSchemaV1;
  params?: StandardSchemaV1;
  query?: StandardSchemaV1;
  headers?: StandardSchemaV1;
  response?: StandardSchemaV1 | Readonly<Record<number, StandardSchemaV1 | null>>;
  middleware?: Middleware | Middleware[];
  hooks?: RouteHooks;
  schema?: never;
  serializer?: never;
}

type TypedBody<Options> =
  Options extends { body: infer Schema }
    ? InferStandardSchema<Schema>
    : unknown;

type TypedParams<Path extends string, Options> =
  Options extends { params: infer Schema }
    ? InferStandardSchema<Schema, PathParams<Path>>
    : PathParams<Path>;

type TypedQuery<Options> =
  Options extends { query: infer Schema }
    ? InferStandardSchema<Schema, Record<string, string | string[]>>
    : Record<string, string | string[]>;

type TypedHeaders<Options> =
  Options extends { headers: infer Schema }
    ? InferStandardSchema<Schema, http.IncomingHttpHeaders>
    : http.IncomingHttpHeaders;

export type TypedRouteInput<Path extends string, Options> = Readonly<{
  request: http.IncomingMessage;
  response: http.ServerResponse;
  method: string;
  path: string;
  route: Path;
  body: TypedBody<Options>;
  params: TypedParams<Path, Options>;
  query: TypedQuery<Options>;
  headers: TypedHeaders<Options>;
  state: Context['state'];
}>;

type ResponseMapResult<Map> = {
  [Status in keyof Map & number]:
    Map[Status] extends StandardSchemaV1<any, infer Output>
      ? HttpReply<Status, Output>
      : HttpReply<Status, undefined>
}[keyof Map & number];

export type TypedRouteResult<Options> =
  Options extends { response: infer Response }
    ? Response extends StandardSchemaV1<any, infer Output>
      ? Output | HttpReply<200, Output>
      : Response extends Readonly<Record<number, StandardSchemaV1 | null>>
        ? ResponseMapResult<Response>
        : unknown
    : unknown;

export type TypedRouteHandler<Path extends string, Options> = (
  input: TypedRouteInput<Path, Options>
) => TypedRouteResult<Options> | Promise<TypedRouteResult<Options>>;

export type Middleware = (ctx: Context, next: Next) => unknown | Promise<unknown>;
export type Handler = (ctx: Context) => unknown | Promise<unknown>;
export type RequestHook = (ctx: Context) => unknown | Promise<unknown>;
export type ValueHook = (ctx: Context, value: unknown) => unknown | Promise<unknown>;
export type ErrorHook = (error: Error, ctx: Context) => unknown | Promise<unknown>;
export type HookName =
  | 'onRequest'
  | 'preParsing'
  | 'preValidation'
  | 'preHandler'
  | 'postHandler'
  | 'preSerialization'
  | 'preSend'
  | 'onResponse'
  | 'onError';

export interface RouteHooks {
  onRequest?: RequestHook | RequestHook[];
  preParsing?: RequestHook | RequestHook[];
  preValidation?: RequestHook | RequestHook[];
  preHandler?: RequestHook | RequestHook[];
  postHandler?: ValueHook | ValueHook[];
  preSerialization?: ValueHook | ValueHook[];
  preSend?: ValueHook | ValueHook[];
  onResponse?: RequestHook | RequestHook[];
  onError?: ErrorHook | ErrorHook[];
}

export type { ExpressMiddleware };

export interface RouteSchema {
  body?: unknown;
  querystring?: unknown;
  params?: unknown;
  headers?: unknown;
  response?: Record<string, unknown>;
}

export type ValidatorResult = boolean | { error?: unknown };
export type Validator = ((value: unknown) => ValidatorResult | Promise<ValidatorResult>) & { errors?: unknown };
export type ValidatorCompiler = (context: {
  schema: unknown;
  method: string;
  url: string;
  httpPart: 'body' | 'querystring' | 'params' | 'headers';
}) => Validator;
export type SerializerCompiler = (context: {
  schema: unknown;
  method: string;
  url: string;
  httpStatus: string;
}) => (body: unknown) => string | Buffer | Uint8Array;

export interface LegacyRouteOptions {
  middleware?: Middleware | Middleware[];
  hooks?: RouteHooks;
  serializer?: (body: unknown) => string | Buffer | Uint8Array;
  schema?: RouteSchema;
  body?: never;
  params?: never;
  query?: never;
  headers?: never;
  response?: never;
}

export type RouteOptions = LegacyRouteOptions | TypedRouteOptions;

export interface ServerLimits {
  requestTimeout?: number;
  headersTimeout?: number;
  keepAliveTimeout?: number;
  maxHeadersCount?: number;
}

export type AppEvent =
  | { type: 'request.start'; at: number; method: string; path: string; route: string | null }
  | { type: 'request.finish'; at: number; method: string; path: string; route: string | null; statusCode: number; durationMs: number; aborted: boolean }
  | { type: 'request.error'; at: number; method: string; path: string; route: string | null; code?: string; statusCode?: number }
  | { type: 'server.listening'; at: number; address: AddressInfo | string | null }
  | { type: 'server.closing'; at: number }
  | { type: 'server.closed'; at: number };

export type AppObserver = (event: AppEvent) => void;

export interface AppOptions {
  pluginTimeout?: number;
  shutdownTimeout?: number;
  server?: ServerOptions;
  tls?: HttpsServerOptions;
  serverLimits?: ServerLimits;
  validatorCompiler?: ValidatorCompiler;
  serializerCompiler?: SerializerCompiler;
  onEvent?: AppObserver;
}

export interface PluginOptions {
  prefix?: string;
  [key: string]: unknown;
}

export type Plugin = (
  app: OpenMesh,
  options: PluginOptions,
  done: (error?: Error) => void
) => void | Promise<void>;

export interface PluginMetadata {
  name?: string;
  global?: boolean;
  dependencies?: string[];
}

type PluginWithMetadata = Plugin & { [PLUGIN]?: Readonly<PluginMetadata> };
type ResponseSerializer = (body: unknown) => string | Buffer | Uint8Array;

const HOOK_NAMES = [
  'onRequest',
  'preParsing',
  'preValidation',
  'preHandler',
  'postHandler',
  'preSerialization',
  'preSend',
  'onResponse',
  'onError'
] as const;

interface HookStore {
  onRequest: RequestHook[];
  preParsing: RequestHook[];
  preValidation: RequestHook[];
  preHandler: RequestHook[];
  postHandler: ValueHook[];
  preSerialization: ValueHook[];
  preSend: ValueHook[];
  onResponse: RequestHook[];
  onError: ErrorHook[];
}

function hookStore(): HookStore {
  return {
    onRequest: [],
    preParsing: [],
    preValidation: [],
    preHandler: [],
    postHandler: [],
    preSerialization: [],
    preSend: [],
    onResponse: [],
    onError: []
  };
}

function hookArray<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function validateHookOptions(hooks: RouteHooks | undefined): void {
  if (hooks === undefined) return;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    throw new TypeError('Route hooks must be an object');
  }
  for (const [name, value] of Object.entries(hooks)) {
    if (!HOOK_NAMES.includes(name as HookName)) throw new TypeError('Unknown hook: ' + name);
    const list = Array.isArray(value) ? value : [value];
    if (list.some(fn => typeof fn !== 'function')) throw new TypeError(name + ' hooks must contain functions');
  }
}

interface TypedRouteRuntime {
  body?: StandardSchemaV1;
  params?: StandardSchemaV1;
  query?: StandardSchemaV1;
  headers?: StandardSchemaV1;
  response?: StandardSchemaV1 | Readonly<Record<number, StandardSchemaV1 | null>>;
}

interface RouteRecord extends Routable {
  method: string;
  path: string;
  scope: OpenMesh;
  handler: Handler;
  serializer?: ((body: unknown, status?: number) => string | Buffer | Uint8Array) | null;
  schema: RouteSchema | null;
  responseSerializers: Map<string, ResponseSerializer> | null;
  middleware: Middleware[];
  localHooks: RouteHooks | null;
  hooks: HookStore;
  typed: TypedRouteRuntime | null;
  run: Handler | null;
}

interface MountRecord {
  prefix: string;
  handler: ExpressMiddleware;
  scope: OpenMesh;
  run: Handler | null;
}

interface NotFoundRecord {
  scope: OpenMesh;
  prefix: string;
  handler: Handler;
  run: Handler | null;
}

interface ResolvedOptions {
  pluginTimeout: number;
  shutdownTimeout: number;
  server: ServerOptions;
  tls: HttpsServerOptions | null;
  serverLimits: ServerLimits;
}

interface ResolvedServerLimits {
  requestTimeout: number;
  headersTimeout: number;
  keepAliveTimeout: number;
  maxHeadersCount: number;
}

function definePluginMetadata(fn: PluginWithMetadata, metadata: PluginMetadata): PluginWithMetadata {
  if (typeof fn !== 'function') throw new TypeError('Plugin must be a function');
  if (metadata.name !== undefined && (typeof metadata.name !== 'string' || !metadata.name)) {
    throw new TypeError('Plugin name must be a nonempty string');
  }
  Object.defineProperty(fn, PLUGIN, { value: Object.freeze({ ...metadata }), configurable: true });
  return fn;
}

export function definePlugin(fn: Plugin, metadata: PluginMetadata = {}): Plugin {
  return definePluginMetadata(fn as PluginWithMetadata, metadata);
}

function prefixPath(parent: string, prefix: string): string {
  if (typeof prefix !== 'string' || (prefix && (!prefix.startsWith('/') || /[?#:*]/.test(prefix)))) {
    throw new TypeError('Prefix must be a literal path beginning with /');
  }
  return parent + (prefix === '/' ? '' : prefix.replace(/\/$/, ''));
}

function inherited(scope: OpenMesh, key: '_middleware'): Middleware[];
function inherited<T>(scope: OpenMesh, key: keyof OpenMesh): T[];
function inherited<T>(scope: OpenMesh, key: keyof OpenMesh): T[] {
  const chain: T[] = [];
  for (let current: OpenMesh | null = scope; current; current = current._parent) {
    chain.unshift(...((current[key] as unknown as T[]) || []));
  }
  return chain;
}

function inheritedHooks<K extends keyof HookStore>(scope: OpenMesh, name: K): HookStore[K] {
  const chain: HookStore[K][number][] = [];
  const scopes: OpenMesh[] = [];
  for (let current: OpenMesh | null = scope; current; current = current._parent) scopes.unshift(current);
  for (const current of scopes) chain.push(...current._hooks[name]);
  return chain as HookStore[K];
}

function compileHooks(scope: OpenMesh, local: RouteHooks | undefined): HookStore {
  const compiled = hookStore();
  for (const name of Object.keys(compiled) as Array<keyof HookStore>) {
    const inherited = inheritedHooks(scope, name) as Array<RequestHook | ValueHook | ErrorHook>;
    const own = local ? hookArray(local[name] as never) as Array<RequestHook | ValueHook | ErrorHook> : [];
    (compiled[name] as Array<RequestHook | ValueHook | ErrorHook>).push(...inherited, ...own);
  }
  return compiled;
}

function validationValue(ctx: Context, part: string): unknown {
  if (part === 'body') return ctx.requestBody;
  if (part === 'querystring') return ctx.query;
  if (part === 'params') return ctx.params;
  if (part === 'headers') return ctx.headers;
  return undefined;
}

async function validateRoute(ctx: Context, validators: Array<[string, Validator]>): Promise<void> {
  for (const [part, validate] of validators) {
    let result: ValidatorResult;
    try {
      result = await validate(validationValue(ctx, part));
    } catch (error) {
      throw new HttpError(400, 'Validation failed for ' + part, { cause: error, code: 'VALIDATION_ERROR' });
    }
    if (result === false || (result && typeof result === 'object' && result.error)) {
      const cause = result && typeof result === 'object' ? result.error : undefined;
      const error = new HttpError(400, 'Validation failed for ' + part, { cause, code: 'VALIDATION_ERROR' });
      if (validate.errors !== undefined) error.validation = validate.errors;
      throw error;
    }
  }
}

function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  const schema = value as StandardSchemaV1 | undefined;
  return !!schema &&
    typeof schema === 'object' &&
    !!schema['~standard'] &&
    schema['~standard'].version === 1 &&
    typeof schema['~standard'].validate === 'function';
}

function typedRouteRuntime(options: RouteOptions): TypedRouteRuntime | null {
  const hasTyped = ['body', 'params', 'query', 'headers', 'response']
    .some(key => options[key as keyof RouteOptions] !== undefined);
  if (!hasTyped) return null;

  if (options.schema) throw new TypeError('Use typed body/params/query/headers/response or schema, not both');
  if (options.serializer) throw new TypeError('Typed response contracts cannot use a route serializer');

  const runtime: TypedRouteRuntime = {};
  for (const part of ['body', 'params', 'query', 'headers'] as const) {
    const schema = options[part];
    if (schema !== undefined) {
      if (!isStandardSchema(schema)) throw new TypeError(part + ' must implement Standard Schema v1');
      runtime[part] = schema;
    }
  }

  if (options.response !== undefined) {
    if (isStandardSchema(options.response)) {
      runtime.response = options.response;
    } else {
      if (!options.response || typeof options.response !== 'object' || Array.isArray(options.response)) {
        throw new TypeError('response must be a Standard Schema or status map');
      }
      const responses: Record<number, StandardSchemaV1 | null> = {};
      for (const [statusText, schema] of Object.entries(options.response)) {
        const status = Number(statusText);
        if (!Number.isInteger(status) || status < 100 || status > 599) {
          throw new TypeError('Typed response status must be 100..599');
        }
        if (schema !== null && !isStandardSchema(schema)) {
          throw new TypeError('Response ' + status + ' must implement Standard Schema v1 or be null');
        }
        responses[status] = schema;
      }
      runtime.response = Object.freeze(responses);
    }
  }

  return runtime;
}

async function validateStandardSchema(
  schema: StandardSchemaV1,
  value: unknown,
  part: string,
  statusCode: number
): Promise<unknown> {
  let result;
  try {
    result = await schema['~standard'].validate(value);
  } catch (cause) {
    throw new HttpError(statusCode, 'Validation failed for ' + part, {
      cause,
      code: statusCode >= 500 ? 'RESPONSE_VALIDATION_ERROR' : 'VALIDATION_ERROR'
    });
  }

  if ('issues' in result && result.issues) {
    const error = new HttpError(statusCode, 'Validation failed for ' + part, {
      code: statusCode >= 500 ? 'RESPONSE_VALIDATION_ERROR' : 'VALIDATION_ERROR'
    });
    error.validation = result.issues;
    throw error;
  }
  return result.value;
}

function isHttpReply(value: unknown): value is HttpReply {
  return !!value &&
    typeof value === 'object' &&
    Number.isInteger((value as HttpReply).status) &&
    'body' in (value as HttpReply);
}

async function typedInput(route: RouteRecord, ctx: Context): Promise<Readonly<Record<string, unknown>>> {
  const typed = route.typed!;
  let body: unknown = ctx.requestBody;
  let params: unknown = ctx.params;
  let query: unknown = ctx.query;
  let headers: unknown = ctx.headers;

  if (typed.body) body = await validateStandardSchema(typed.body, body, 'body', 400);
  if (typed.params) params = await validateStandardSchema(typed.params, params, 'params', 400);
  if (typed.query) query = await validateStandardSchema(typed.query, query, 'query', 400);
  if (typed.headers) headers = await validateStandardSchema(typed.headers, headers, 'headers', 400);

  return Object.freeze({
    request: ctx.req,
    response: ctx.res,
    method: ctx.method || route.method,
    path: ctx.path,
    route: route.path,
    body,
    params,
    query,
    headers,
    state: ctx.state
  });
}

async function typedOutput(route: RouteRecord, ctx: Context, returned: unknown): Promise<unknown> {
  const typed = route.typed!;
  let status = 200;
  let body = returned;

  if (isHttpReply(returned)) {
    status = returned.status;
    body = returned.body;
    if (returned.headers) ctx.set(returned.headers);
  }

  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new HttpError(500, 'Typed handler returned an invalid status', { code: 'INVALID_RESPONSE_STATUS' });
  }

  const response = typed.response;
  if (response) {
    if (isStandardSchema(response)) {
      if (status !== 200) {
        throw new HttpError(500, 'Typed handler returned undeclared status ' + status, {
          code: 'UNDECLARED_RESPONSE_STATUS'
        });
      }
      body = await validateStandardSchema(response, body, 'response.200', 500);
    } else {
      if (!Object.hasOwn(response, status)) {
        throw new HttpError(500, 'Typed handler returned undeclared status ' + status, {
          code: 'UNDECLARED_RESPONSE_STATUS'
        });
      }
      const schema = response[status];
      if (schema === null) {
        if (body !== undefined) {
          throw new HttpError(500, 'Response ' + status + ' must not include a body', {
            code: 'RESPONSE_VALIDATION_ERROR'
          });
        }
      } else if (schema) {
        body = await validateStandardSchema(schema, body, 'response.' + status, 500);
      }
    }
  }

  ctx.status = status;
  return body;
}

function compileRouteSchema(route: RouteRecord): Array<[string, Validator]> {
  const schema = route.schema;
  if (!schema) return [];

  const validators: Array<[string, Validator]> = [];
  for (const part of ['body', 'querystring', 'params', 'headers'] as const) {
    if (schema[part] === undefined) continue;
    const compiler = route.scope._validatorCompiler;
    if (typeof compiler !== 'function') {
      throw new Error('Route schema requires a validator compiler: ' + route.method + ' ' + route.path);
    }
    const validate = compiler({ schema: schema[part], method: route.method, url: route.path, httpPart: part });
    if (typeof validate !== 'function') throw new TypeError('Validator compiler must return a function');
    validators.push([part, validate]);
  }

  if (schema.response !== undefined) {
    if (!schema.response || typeof schema.response !== 'object' || Array.isArray(schema.response)) {
      throw new TypeError('schema.response must be an object');
    }
    const compiler = route.scope._serializerCompiler;
    if (typeof compiler !== 'function') {
      throw new Error('schema.response requires a serializer compiler: ' + route.method + ' ' + route.path);
    }
    const serializers = new Map<string, ResponseSerializer>();
    for (const [status, responseSchema] of Object.entries(schema.response)) {
      const key = status.toLowerCase();
      if (!/^(?:[1-5]\d\d|[1-5]xx|default)$/.test(key)) {
        throw new TypeError('Invalid response schema status: ' + status);
      }
      const serialize = compiler({ schema: responseSchema, method: route.method, url: route.path, httpStatus: key });
      if (typeof serialize !== 'function') throw new TypeError('Serializer compiler must return a function');
      serializers.set(key, serialize);
    }
    route.responseSerializers = serializers;
  }

  return validators;
}

function responseSerializer(route: RouteRecord | null | undefined, status: number): ResponseSerializer | undefined {
  const serializers = route?.responseSerializers;
  if (!serializers) return route?.serializer || undefined;
  return serializers.get(String(status)) || serializers.get(Math.floor(status / 100) + 'xx') || serializers.get('default');
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return !!value && typeof (value as PromiseLike<unknown>).then === 'function';
}

function runHookList<T extends (...args: any[]) => unknown>(
  hooks: readonly T[],
  args: Parameters<T>
): void | Promise<void> {
  let chain: Promise<void> | null = null;

  for (const hook of hooks) {
    if (chain) {
      chain = chain.then(() => Promise.resolve(hook(...args)).then(() => undefined));
      continue;
    }
    const value = hook(...args);
    if (isPromiseLike(value)) chain = Promise.resolve(value).then(() => undefined);
  }

  return chain || undefined;
}

function responseValue(ctx: Context, returned: unknown): unknown {
  return ctx.body !== undefined ? ctx.body : returned === ctx ? undefined : returned;
}

function runBeforeRouteHooks(hooks: HookStore, ctx: Context): void | Promise<void> {
  const request = hooks.onRequest.length ? runHookList(hooks.onRequest, [ctx]) : undefined;
  if (isPromiseLike(request)) {
    return Promise.resolve(request).then(() => {
      const parsing = hooks.preParsing.length ? runHookList(hooks.preParsing, [ctx]) : undefined;
      return isPromiseLike(parsing) ? Promise.resolve(parsing) : undefined;
    });
  }
  return hooks.preParsing.length ? runHookList(hooks.preParsing, [ctx]) : undefined;
}

function runPreSerializationHooks(hooks: HookStore, ctx: Context, value: unknown): void | Promise<void> {
  return hooks.preSerialization.length
    ? runHookList(hooks.preSerialization, [ctx, value])
    : undefined;
}

function runPreSendHooks(hooks: HookStore, ctx: Context, value: unknown): void | Promise<void> {
  return hooks.preSend.length
    ? runHookList(hooks.preSend, [ctx, value])
    : undefined;
}

function attachResponseHooks(hooks: HookStore, ctx: Context): void {
  if (!hooks.onResponse.length) return;
  let finished = false;
  const run = (): void => {
    if (finished) return;
    finished = true;
    ctx.res.off('finish', run);
    ctx.res.off('close', run);
    try {
      const result = runHookList(hooks.onResponse, [ctx]);
      if (isPromiseLike(result)) void Promise.resolve(result).catch(() => {});
    } catch {}
  };
  ctx.res.once('finish', run);
  ctx.res.once('close', run);
}

function sendWithHooks(
  hooks: HookStore,
  ctx: Context,
  value: unknown,
  onFailure: (error: unknown) => void
): void {
  const prepare = (): void => {
    let prepared;
    try {
      prepared = prepareResponse(ctx, value);
    } catch (error) {
      onFailure(error);
      return;
    }

    let beforeSend: void | Promise<void>;
    try {
      beforeSend = runPreSendHooks(hooks, ctx, prepared.body);
    } catch (error) {
      onFailure(error);
      return;
    }

    const finish = (): void => {
      try {
        sendPrepared(ctx, prepared);
      } catch (error) {
        onFailure(error);
      }
    };

    if (isPromiseLike(beforeSend)) {
      Promise.resolve(beforeSend).then(finish, onFailure);
    } else {
      finish();
    }
  };

  let beforeSerialization: void | Promise<void>;
  try {
    beforeSerialization = runPreSerializationHooks(hooks, ctx, responseValue(ctx, value));
  } catch (error) {
    onFailure(error);
    return;
  }

  if (isPromiseLike(beforeSerialization)) {
    Promise.resolve(beforeSerialization).then(prepare, onFailure);
  } else {
    prepare();
  }
}

export class OpenMesh {
  _root: OpenMesh;
  _parent: OpenMesh | null = null;
  _prefix = '';
  _middleware: Middleware[] = [];
  _hooks: HookStore = hookStore();
  _pending: Array<{ plugin: PluginWithMetadata; options: PluginOptions }> = [];
  _names = new Set<string>();
  _routes: RouteRecord[] = [];
  _mounts: MountRecord[] = [];
  _shutdownHooks: Array<() => unknown | Promise<unknown>> = [];
  _closeHooks: Array<() => unknown | Promise<unknown>> = [];
  _listenHooks: Array<(address: AddressInfo | string | null) => unknown | Promise<unknown>> = [];
  _phase = 'configuring';
  _readyPromise: Promise<OpenMesh> | null = null;
  _closePromise: Promise<void> | null = null;
  _router = new Router<RouteRecord>();
  _notFoundHandlers: NotFoundRecord[] = [];
  _errorHandler: ((error: Error, ctx: Context) => unknown | Promise<unknown>) | null = null;
  _sockets = new Set<import('node:net').Socket>();
  _server: http.Server | https.Server | null = null;
  _options: ResolvedOptions;
  _serverLimits: ResolvedServerLimits;
  _validatorCompiler: ValidatorCompiler | null;
  _serializerCompiler: SerializerCompiler | null;
  _observer: AppObserver | null;
  _listener: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  _listenHooksPromise: Promise<void> | null = null;
  _fallback: Handler = ctx => this._fallbackHandler(ctx);

  constructor(options: AppOptions = {}) {
    this._root = this;
    this._options = {
      pluginTimeout: 10000,
      shutdownTimeout: 5000,
      server: {},
      tls: null,
      serverLimits: {},
      ...options
    };
    for (const key of ['pluginTimeout', 'shutdownTimeout'] as const) {
      if (!Number.isFinite(this._options[key]) || this._options[key] < 0) {
        throw new TypeError(key + ' must be a nonnegative finite number');
      }
    }
    if (
      this._options.tls !== null &&
      (!this._options.tls || typeof this._options.tls !== 'object' || Array.isArray(this._options.tls))
    ) {
      throw new TypeError('tls must be an HTTPS server options object');
    }

    this._serverLimits = {
      requestTimeout: 120000,
      headersTimeout: 10000,
      keepAliveTimeout: 5000,
      maxHeadersCount: 100,
      ...this._options.serverLimits
    };
    for (const key of ['requestTimeout', 'headersTimeout', 'keepAliveTimeout', 'maxHeadersCount'] as const) {
      if (!Number.isSafeInteger(this._serverLimits[key]) || this._serverLimits[key] < 0) {
        throw new TypeError(key + ' must be a nonnegative integer');
      }
    }
    if (this._serverLimits.requestTimeout && this._serverLimits.headersTimeout > this._serverLimits.requestTimeout) {
      throw new RangeError('headersTimeout cannot exceed requestTimeout');
    }

    this._validatorCompiler = options.validatorCompiler ?? null;
    this._serializerCompiler = options.serializerCompiler ?? null;
    if (this._validatorCompiler !== null && typeof this._validatorCompiler !== 'function') {
      throw new TypeError('validatorCompiler must be a function');
    }
    if (this._serializerCompiler !== null && typeof this._serializerCompiler !== 'function') {
      throw new TypeError('serializerCompiler must be a function');
    }
    if (options.onEvent !== undefined && typeof options.onEvent !== 'function') {
      throw new TypeError('onEvent must be a function');
    }
    this._observer = options.onEvent ?? null;
    this._listener = (req, res) => this._dispatch(req, res);
  }

  get server(): http.Server | https.Server | null { return this._root._server; }
  get phase(): string { return this._root._phase; }
  get prefix(): string { return this._prefix; }
  get version(): string { return '0.5.0'; }

  _updateTlsContext(tls: HttpsServerOptions): this {
    const root = this._root;
    if (!tls || typeof tls !== 'object' || Array.isArray(tls)) {
      throw new TypeError('tls must be an HTTPS server options object');
    }
    if (!root._options.tls) throw new Error('Application TLS is not configured');

    const next = { ...root._options.tls, ...tls };
    if (root._server) {
      if (typeof (root._server as https.Server).setSecureContext !== 'function') {
        throw new Error('Application is not using an HTTPS server');
      }
      (root._server as https.Server).setSecureContext(next);
    }
    root._options.tls = next;
    return this;
  }

  _emit(event: AppEvent): void {
    const observer = this._root._observer;
    if (!observer) return;
    try { observer(event); } catch {}
  }

  _assertMutable(): void {
    if (!['configuring', 'booting'].includes(this._root._phase)) {
      throw new Error('Configure routes and plugins before ready() or listen()');
    }
  }

  use(fn: Middleware): this {
    this._assertMutable();
    if (typeof fn !== 'function') throw new TypeError('Middleware must be a function');
    this._middleware.push(fn);
    return this;
  }

  useExpress(fn: ExpressMiddleware): this {
    return this.use(expressMiddleware(fn));
  }

  addHook(name: 'postHandler' | 'preSerialization' | 'preSend', fn: ValueHook): this;
  addHook(name: 'onError', fn: ErrorHook): this;
  addHook(name: 'onRequest' | 'preParsing' | 'preValidation' | 'preHandler' | 'onResponse', fn: RequestHook): this;
  addHook(name: HookName, fn: RequestHook | ValueHook | ErrorHook): this {
    this._assertMutable();
    if (!HOOK_NAMES.includes(name)) throw new TypeError('Unknown hook: ' + name);
    if (typeof fn !== 'function') throw new TypeError(name + ' hook must be a function');
    (this._hooks[name] as Array<RequestHook | ValueHook | ErrorHook>).push(fn);
    return this;
  }

  route(method: string, path: string, handler: Handler): this;
  route<const Path extends string, const Options extends TypedRouteOptions>(
    method: string,
    path: Path,
    options: Options,
    handler: TypedRouteHandler<Path, Options>
  ): this;
  route(method: string, path: string, options: LegacyRouteOptions, handler: Handler): this;
  route(
    method: string,
    path: string,
    optionsOrHandler: RouteOptions | Handler,
    maybeHandler?: Handler | ((input: any) => unknown)
  ): this {
    this._assertMutable();
    const options: RouteOptions = typeof optionsOrHandler === 'function' ? {} : optionsOrHandler;
    const handler = typeof optionsOrHandler === 'function' ? optionsOrHandler : maybeHandler;

    if (typeof handler !== 'function') throw new TypeError('Route handler must be a function');
    if (typeof path !== 'string' || !path.startsWith('/')) throw new TypeError('Route path must be a string beginning with /');
    if (typeof method !== 'string' || !/^(\*|[A-Z]+)$/.test(method)) throw new TypeError('HTTP method must be uppercase or *');
    if (options.serializer !== undefined && typeof options.serializer !== 'function') throw new TypeError('Serializer must be a function');
    validateHookOptions(options.hooks);
    if (options.schema !== undefined && (!options.schema || typeof options.schema !== 'object' || Array.isArray(options.schema))) {
      throw new TypeError('Route schema must be an object');
    }
    if (options.serializer && options.schema?.response) throw new TypeError('Use either route serializer or schema.response, not both');

    const middleware = options.middleware === undefined ? [] : Array.isArray(options.middleware) ? options.middleware : [options.middleware];
    if (middleware.some(fn => typeof fn !== 'function')) throw new TypeError('Route middleware must contain functions');
    const typed = typedRouteRuntime(options);

    const route: RouteRecord = {
      method,
      path: this._prefix + path,
      scope: this,
      handler: handler as Handler,
      serializer: options.serializer || null,
      schema: options.schema || null,
      responseSerializers: null,
      middleware,
      localHooks: options.hooks || null,
      hooks: hookStore(),
      typed,
      run: null,
      paramNames: []
    };
    this._root._router.add(method, route.path, route);
    this._root._routes.push(route);
    return this;
  }

  all(path: string, handler: Handler): this;
  all<const Path extends string, const Options extends TypedRouteOptions>(
    path: Path,
    options: Options,
    handler: TypedRouteHandler<Path, Options>
  ): this;
  all(path: string, options: LegacyRouteOptions, handler: Handler): this;
  all(
    path: string,
    optionsOrHandler: RouteOptions | Handler,
    maybeHandler?: Handler | ((input: any) => unknown)
  ): this {
    return typeof optionsOrHandler === 'function'
      ? this.route('*', path, optionsOrHandler)
      : (this.route as (...args: any[]) => this)('*', path, optionsOrHandler, maybeHandler);
  }

  register(plugin: Plugin, options: PluginOptions = {}): this {
    this._assertMutable();
    if (typeof plugin !== 'function') throw new TypeError('Plugin must be a function');
    this._pending.push({ plugin: plugin as PluginWithMetadata, options });
    return this;
  }

  setValidatorCompiler(compiler: ValidatorCompiler): this {
    this._assertMutable();
    if (typeof compiler !== 'function') throw new TypeError('Validator compiler must be a function');
    this._validatorCompiler = compiler;
    return this;
  }

  setSerializerCompiler(compiler: SerializerCompiler): this {
    this._assertMutable();
    if (typeof compiler !== 'function') throw new TypeError('Serializer compiler must be a function');
    this._serializerCompiler = compiler;
    return this;
  }

  decorate(name: string, value: unknown): this {
    this._assertMutable();
    if (
      typeof name !== 'string' || !name || name.startsWith('_') || name in OpenMesh.prototype ||
      ['__proto__', 'prototype', 'constructor'].includes(name) || Object.hasOwn(this, name)
    ) {
      throw new Error('Duplicate or reserved decoration: ' + name);
    }
    Object.defineProperty(this, name, { value, writable: true, enumerable: true, configurable: true });
    return this;
  }

  hasPlugin(name: string): boolean {
    for (let scope: OpenMesh | null = this; scope; scope = scope._parent) if (scope._names.has(name)) return true;
    return false;
  }

  onShutdown(fn: (app: OpenMesh) => unknown | Promise<unknown>): this {
    this._assertMutable();
    if (typeof fn !== 'function') throw new TypeError('Shutdown hook must be a function');
    this._root._shutdownHooks.push(() => fn(this));
    return this;
  }

  onClose(fn: (app: OpenMesh) => unknown | Promise<unknown>): this {
    this._assertMutable();
    if (typeof fn !== 'function') throw new TypeError('Close hook must be a function');
    this._root._closeHooks.push(() => fn(this));
    return this;
  }

  onListen(fn: (app: OpenMesh, address: AddressInfo | string | null) => unknown | Promise<unknown>): this {
    this._assertMutable();
    if (typeof fn !== 'function') throw new TypeError('Listen hook must be a function');
    this._root._listenHooks.push(address => fn(this, address));
    return this;
  }

  setErrorHandler(fn: (error: Error, ctx: Context) => unknown | Promise<unknown>): this {
    this._assertMutable();
    if (typeof fn !== 'function') throw new TypeError('Error handler must be a function');
    this._errorHandler = fn;
    return this;
  }

  setNotFoundHandler(fn: Handler): this {
    this._assertMutable();
    if (typeof fn !== 'function') throw new TypeError('Not-found handler must be a function');
    const root = this._root;
    const existing = root._notFoundHandlers.find(entry => entry.scope === this);
    if (existing) existing.handler = fn;
    else root._notFoundHandlers.push({ scope: this, prefix: this._prefix, handler: fn, run: null });
    return this;
  }

  mount(prefix: string, handler: ExpressMiddleware, options: { close?: () => void | Promise<void> } = {}): this {
    this._assertMutable();
    if (typeof handler !== 'function') throw new TypeError('Mount expects a Node/Express (req, res, next) handler');
    const fullPrefix = prefixPath(this._prefix, prefix);
    if (this._root._mounts.some(m => m.prefix === fullPrefix)) throw new Error('Duplicate mount: ' + fullPrefix);
    this._root._mounts.push({ prefix: fullPrefix, handler, scope: this, run: null });
    if (options.close) this.onClose(options.close);
    return this;
  }

  fastify(
    prefix: string,
    plugin: (app: any, options: any, done: (error?: Error) => void) => void | Promise<void>,
    options: { server?: Record<string, unknown>; plugin?: Record<string, unknown> } = {}
  ): this {
    this._assertMutable();
    if (typeof plugin !== 'function') throw new TypeError('Fastify bridge expects a plugin function');

    return this.register(async scope => {
      let factory: any;
      try {
        factory = (await import('fastify')).default;
      } catch (error) {
        throw new Error('Install optional peer dependency: npm install fastify@5', { cause: error });
      }
      const host = factory(options.server || {});
      scope.onClose(() => host.close());
      host.register(plugin, options.plugin || {});
      await host.ready();
      scope.mount(prefix, (req, res) => host.routing(req, res));
    }, { prefix: '' });
  }

  async _boot(): Promise<void> {
    for (let index = 0; index < this._pending.length; index++) {
      const { plugin, options } = this._pending[index]!;
      const metadata = plugin[PLUGIN] || {};
      for (const dependency of metadata.dependencies || []) {
        if (!this.hasPlugin(dependency)) throw new Error('Missing plugin dependency: ' + dependency);
      }
      if (metadata.name && this._names.has(metadata.name)) throw new Error('Duplicate plugin: ' + metadata.name);
      if (metadata.global && options.prefix) throw new Error('Global plugins cannot have a route prefix');

      const scope = metadata.global ? this : Object.create(this) as OpenMesh;
      if (scope !== this) {
        scope._parent = this;
        scope._prefix = prefixPath(this._prefix, String(options.prefix || ''));
        scope._middleware = [];
        scope._hooks = hookStore();
        scope._pending = [];
        scope._names = new Set();
      }

      await new Promise<void>((resolve, reject) => {
        let finished = false;
        const timer = this._root._options.pluginTimeout
          ? setTimeout(() => done(new Error('Plugin startup timed out: ' + (metadata.name || plugin.name || 'anonymous'))), this._root._options.pluginTimeout)
          : null;

        function done(error?: Error): void {
          if (finished) return;
          finished = true;
          if (timer) clearTimeout(timer);
          error ? reject(error) : resolve();
        }

        try {
          const returned = plugin(scope, options, done);
          if (returned && typeof (returned as PromiseLike<void>).then === 'function') {
            if (plugin.length >= 3) {
              Promise.resolve(returned).catch(() => {});
              done(new Error('Plugin cannot mix a Promise with a done callback'));
            } else {
              Promise.resolve(returned).then(() => done(), error => done(error instanceof Error ? error : new Error(String(error))));
            }
          } else if (plugin.length < 3) {
            done();
          }
        } catch (error) {
          done(error instanceof Error ? error : new Error(String(error)));
        }
      });

      if (metadata.name) scope._names.add(metadata.name);
      if (scope !== this) await scope._boot();
    }
  }

  _compile(): void {
    for (const route of this._routes) {
      const middleware = [...inherited(route.scope, '_middleware'), ...route.middleware];
      const validators = compileRouteSchema(route);
      route.hooks = compileHooks(route.scope, route.localHooks || undefined);

      if (route.responseSerializers) {
        route.serializer = (body, status = 200) => {
          const serialize = responseSerializer(route, status);
          return serialize ? serialize(body) : JSON.stringify(body);
        };
      }

      const hasHandlerHooks =
        route.hooks.preValidation.length > 0 ||
        route.hooks.preHandler.length > 0 ||
        route.hooks.postHandler.length > 0;

      const invoke: Handler = validators.length || hasHandlerHooks || route.typed
        ? async ctx => {
            if (route.hooks.preValidation.length) {
              await runHookList(route.hooks.preValidation, [ctx]);
            }

            if (validators.length) await validateRoute(ctx, validators);
            const input = route.typed ? await typedInput(route, ctx) : ctx;

            if (route.hooks.preHandler.length) {
              await runHookList(route.hooks.preHandler, [ctx]);
            }

            let value = await (route.handler as unknown as (input: unknown) => unknown)(input);
            if (route.typed) value = await typedOutput(route, ctx, value);

            if (route.hooks.postHandler.length) {
              await runHookList(route.hooks.postHandler, [ctx, value]);
            }
            return value;
          }
        : route.handler;

      const handler: Handler = ctx => {
        const value = invoke(ctx);
        if (isPromiseLike(value)) {
          return Promise.resolve(value).then(result => {
            if (ctx.body === undefined && result !== ctx) ctx.body = result;
            return result;
          });
        }
        if (ctx.body === undefined && value !== ctx) ctx.body = value;
        return value;
      };

      route.run = middleware.length ? compose(middleware, handler) : invoke;
    }

    for (const mount of this._mounts) {
      const middleware = inherited(mount.scope, '_middleware');
      const handler: Handler = ctx => invokeMiddleware(mount.handler, ctx, mount.prefix).then(() => {
        if (!ctx.res.writableEnded && !ctx.res.destroyed) {
          throw new HttpError(404, 'Mounted application did not handle the request');
        }
      });
      mount.run = middleware.length ? compose(middleware, handler) : handler;
    }

    for (const entry of this._notFoundHandlers) {
      const middleware = inherited(entry.scope, '_middleware');
      const handler: Handler = ctx => {
        const value = entry.handler(ctx);
        if (isPromiseLike(value)) {
          return Promise.resolve(value).then(result => {
            if (ctx.body === undefined && result !== ctx) ctx.body = result;
            return result;
          });
        }
        if (ctx.body === undefined && value !== ctx) ctx.body = value;
        return value;
      };
      entry.run = middleware.length ? compose(middleware, handler) : handler;
    }

    this._mounts.sort((a, b) => b.prefix.length - a.prefix.length);
    this._notFoundHandlers.sort((a, b) => b.prefix.length - a.prefix.length);
    this._fallback = this._middleware.length
      ? compose(this._middleware, ctx => this._fallbackHandler(ctx))
      : ctx => this._fallbackHandler(ctx);
  }

  ready(): Promise<this> {
    const root = this._root;
    if (this !== root && root._phase === 'booting') {
      return Promise.reject(new Error('Do not call ready() from a plugin; return from the plugin instead'));
    }
    if (root._readyPromise) return root._readyPromise as Promise<this>;
    if (['closing', 'closed', 'failed'].includes(root._phase)) {
      return Promise.reject(new Error('Application is ' + root._phase));
    }

    root._phase = 'booting';
    root._readyPromise = root._boot().then(
      () => {
        root._compile();
        root._phase = 'ready';
        return root;
      },
      async error => {
        root._phase = 'failed';
        try {
          await root._runCloseHooks();
        } catch (cleanup) {
          error = new AggregateError([error, cleanup], 'Startup failed and cleanup failed');
        }
        throw error;
      }
    );
    return root._readyPromise as Promise<this>;
  }

  callback(): (req: http.IncomingMessage, res: http.ServerResponse) => void {
    const root = this._root;
    if (root._phase === 'configuring' && !root._pending.length) {
      root._compile();
      root._phase = 'ready';
      root._readyPromise = Promise.resolve(root);
    }
    if (!['ready', 'listening'].includes(root._phase)) {
      throw new Error('await app.ready() before callback() when using plugins');
    }
    return root._listener;
  }

  async listen(options: ListenOptions | number = {}): Promise<AddressInfo | string | null> {
    const root = this._root;
    await root.ready();
    if (root._server || root._phase !== 'ready') throw new Error('Application has already started or closed');

    const listenOptions: ListenOptions = typeof options === 'number' ? { port: options } : options;
    root._server = root._options.tls
      ? https.createServer({ ...root._options.server, ...root._options.tls }, root._listener)
      : http.createServer(root._options.server, root._listener);
    root._server.requestTimeout = root._serverLimits.requestTimeout;
    root._server.headersTimeout = root._serverLimits.headersTimeout;
    root._server.keepAliveTimeout = root._serverLimits.keepAliveTimeout;
    root._server.maxHeadersCount = root._serverLimits.maxHeadersCount;
    root._server.on('connection', socket => {
      root._sockets.add(socket);
      socket.once('close', () => root._sockets.delete(socket));
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => {
          root._server!.off('listening', started);
          reject(error);
        };
        const started = () => {
          root._server!.off('error', failed);
          resolve();
        };
        root._server!.once('error', failed);
        root._server!.once('listening', started);
        root._server!.listen({ port: 0, host: '127.0.0.1', ...listenOptions });
      });

      root._phase = 'listening';
      const address = root._server.address();
      root._listenHooksPromise = (async () => {
        for (const hook of root._listenHooks) await hook(address);
      })();
      await root._listenHooksPromise;
      root._emit({ type: 'server.listening', at: Date.now(), address });
      return address;
    } catch (error) {
      if (root._server?.listening) {
        try {
          await root.close();
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'Listen hook failed and cleanup failed');
        }
      } else {
        root._server = null;
      }
      throw error;
    }
  }

  async _runShutdownHooks(): Promise<void> {
    const errors: unknown[] = [];
    for (const hook of this._shutdownHooks.splice(0).reverse()) {
      try { await hook(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Shutdown hooks failed');
  }

  async _runCloseHooks(): Promise<void> {
    const errors: unknown[] = [];
    for (const hook of this._closeHooks.splice(0).reverse()) {
      try { await hook(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Close hooks failed');
  }

  close(options: { timeout?: number } = {}): Promise<void> {
    const root = this._root;
    if (root._closePromise) return root._closePromise;

    const timeout = options.timeout ?? root._options.shutdownTimeout;
    if (!Number.isFinite(timeout) || timeout < 0) {
      return Promise.reject(new TypeError('Shutdown timeout must be finite and nonnegative'));
    }

    root._closePromise = (async () => {
      if (root._phase === 'booting') {
        try { await root._readyPromise; } catch {}
      }
      root._phase = 'closing';
      if (root._server) root._emit({ type: 'server.closing', at: Date.now() });
      if (root._listenHooksPromise) {
        try { await root._listenHooksPromise; } catch {}
      }

      const errors: unknown[] = [];
      try { await root._runShutdownHooks(); } catch (error) { errors.push(error); }
      try {
        if (root._server?.listening) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              for (const socket of root._sockets) socket.destroy();
            }, timeout);
            root._server!.close(error => {
              clearTimeout(timer);
              error ? reject(error) : resolve();
            });
            root._server!.closeIdleConnections();
          });
        }
      } catch (error) {
        errors.push(error);
      }

      try { await root._runCloseHooks(); } catch (error) { errors.push(error); }
      root._phase = 'closed';
      if (root._server) root._emit({ type: 'server.closed', at: Date.now() });
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Application shutdown failed');
    })();

    return root._closePromise;
  }

  _fallbackHandler(ctx: Context): unknown {
    const allowed = this._router.allowed(ctx.path);
    if (allowed.length) {
      ctx.status = 405;
      ctx.set('allow', allowed.join(', '));
      return ctx.send({ error: 'Method Not Allowed' });
    }
    ctx.status = 404;
    return ctx.send({ error: 'Not Found' });
  }

  _dispatch(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this._phase === 'closing' || this._phase === 'closed' || this._phase === 'failed') {
      res.writeHead(503, { connection: 'close', 'content-type': 'application/json' });
      res.end('{"error":"Service Unavailable"}');
      return;
    }

    const url = req.url || '/';
    const queryIndex = url.indexOf('?');
    const path = queryIndex < 0 ? url : url.slice(0, queryIndex);
    let ctx: Context | undefined;
    let hooks: HookStore = this._hooks;

    const send = (value: unknown): void => {
      const target = ctx!;
      sendWithHooks(hooks, target, value, error => this._handleError(error, target, hooks));
    };

    const execute = (
      route: RouteRecord | MountRecord | undefined,
      notFound: NotFoundRecord | null
    ): void => {
      let result: unknown;
      try {
        result = route
          ? (route as unknown as { run: Handler }).run(ctx!)
          : notFound
            ? notFound.run!(ctx!)
            : this._fallback(ctx!);
      } catch (error) {
        this._handleError(error, ctx!, hooks);
        return;
      }

      if (isPromiseLike(result)) {
        Promise.resolve(result).then(send, error => this._handleError(error, ctx!, hooks));
      } else {
        send(result);
      }
    };

    try {
      const match = this._router.find(path, req.method || 'GET');
      let route: RouteRecord | MountRecord | undefined = match?.route;
      if (!route) {
        route = this._mounts.find(m => !m.prefix || path === m.prefix || path.startsWith(m.prefix + '/'));
      }

      let notFound: NotFoundRecord | null = null;
      if (!route && !this._router.allowed(path).length) {
        notFound = this._notFoundHandlers.find(entry => !entry.prefix || path === entry.prefix || path.startsWith(entry.prefix + '/')) || null;
      }

      const actualRoute = route && 'paramNames' in route ? route : null;
      const scope = route?.scope || notFound?.scope || this;
      hooks = actualRoute?.hooks || compileHooks(scope, undefined);

      ctx = new Context(req, res, scope, path, actualRoute, match?.values || null);
      ctx.routePattern = actualRoute?.path
        || (route && 'prefix' in route ? route.prefix : null)
        || notFound?.prefix
        || null;

      attachResponseHooks(hooks, ctx);

      if (this._root._observer) {
        const started = performance.now();
        let observedFinish = false;
        const finish = (aborted: boolean): void => {
          if (observedFinish) return;
          observedFinish = true;
          res.off('finish', finished);
          res.off('close', closed);
          this._emit({
            type: 'request.finish',
            at: Date.now(),
            method: req.method || 'GET',
            path,
            route: ctx!.routePattern,
            statusCode: res.statusCode,
            durationMs: performance.now() - started,
            aborted
          });
        };
        const finished = (): void => finish(false);
        const closed = (): void => finish(!res.writableFinished);
        res.once('finish', finished);
        res.once('close', closed);
        this._emit({ type: 'request.start', at: Date.now(), method: req.method || 'GET', path, route: ctx.routePattern });
      }

      const before = runBeforeRouteHooks(hooks, ctx);
      if (isPromiseLike(before)) {
        Promise.resolve(before).then(
          () => execute(route, notFound),
          error => this._handleError(error, ctx!, hooks)
        );
      } else {
        execute(route, notFound);
      }
    } catch (error) {
      this._handleError(error, ctx || new Context(req, res, this, path, null, null), hooks);
    }
  }

  _handleError(error: unknown, ctx: Context, hooks: HookStore = this._hooks): void {
    const normalized = error instanceof Error ? error : new Error('Request failed', { cause: error });
    const observed = normalized as Error & { code?: string; statusCode?: number };
    this._emit({
      type: 'request.error',
      at: Date.now(),
      method: ctx.req.method || 'GET',
      path: ctx.path,
      route: ctx.routePattern,
      ...(observed.code ? { code: observed.code } : {}),
      ...(Number.isInteger(observed.statusCode) ? { statusCode: observed.statusCode } : {})
    });

    const proceed = (): void => this._handleErrorAfterHooks(normalized, ctx, hooks);

    if (hooks.onError.length) {
      try {
        const value = runHookList(hooks.onError, [normalized, ctx]);
        if (isPromiseLike(value)) {
          Promise.resolve(value).then(proceed, proceed);
          return;
        }
      } catch {}
    }

    proceed();
  }

  _handleErrorAfterHooks(normalized: Error, ctx: Context, hooks: HookStore): void {
    if (ctx.res.writableEnded || ctx.res.destroyed) return;
    if (ctx.res.headersSent) {
      ctx.res.destroy(normalized);
      return;
    }

    ctx.body = undefined;
    const handler = ctx.app._errorHandler;
    if (handler) {
      const sendHandled = (value: unknown): void => {
        sendWithHooks(hooks, ctx, value, failure => this._defaultError(failure, ctx));
      };

      try {
        const result = handler(normalized, ctx);
        if (isPromiseLike(result)) {
          Promise.resolve(result).then(sendHandled, failure => this._defaultError(failure, ctx));
        } else {
          sendHandled(result);
        }
        return;
      } catch (failure) {
        this._defaultError(failure, ctx);
        return;
      }
    }

    this._defaultError(normalized, ctx);
  }

  _defaultError(error: unknown, ctx: Context): void {
    const normalized = error instanceof Error ? error : new Error('Request failed', { cause: error });
    if (ctx.res.writableEnded || ctx.res.destroyed) return;

    const candidate = normalized as Error & { statusCode?: number; expose?: boolean };
    const status = Number.isInteger(candidate.statusCode) && candidate.statusCode! >= 400 && candidate.statusCode! <= 599
      ? candidate.statusCode!
      : 500;
    ctx.res.statusCode = status;
    ctx.res.removeHeader('content-length');
    ctx.res.removeHeader('content-encoding');
    ctx.res.setHeader('content-type', 'application/json; charset=utf-8');
    ctx.res.end(JSON.stringify({ error: status < 500 && candidate.expose !== false ? normalized.message : 'Internal Server Error' }));
  }
}

export interface RouteMethod {
  (path: string, handler: Handler): OpenMesh;
  <const Path extends string, const Options extends TypedRouteOptions>(
    path: Path,
    options: Options,
    handler: TypedRouteHandler<Path, Options>
  ): OpenMesh;
  (path: string, options: LegacyRouteOptions, handler: Handler): OpenMesh;
}

export interface OpenMesh {
  get: RouteMethod;
  head: RouteMethod;
  post: RouteMethod;
  put: RouteMethod;
  patch: RouteMethod;
  delete: RouteMethod;
  options: RouteMethod;
  trace: RouteMethod;
}

for (const method of METHODS) {
  (OpenMesh.prototype as unknown as Record<string, RouteMethod>)[method.toLowerCase()] = function (
    this: OpenMesh,
    path: string,
    optionsOrHandler: RouteOptions | Handler,
    maybeHandler?: Handler | ((input: any) => unknown)
  ): OpenMesh {
    return typeof optionsOrHandler === 'function'
      ? this.route(method, path, optionsOrHandler)
      : (this.route as (...args: any[]) => OpenMesh)(method, path, optionsOrHandler, maybeHandler);
  } as RouteMethod;
}
