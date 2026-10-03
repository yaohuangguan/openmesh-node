import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { Context } from '../core/context.js';
import { HttpError } from '../core/context.js';
import type { Plugin } from '../core/app.js';

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

export type InferSchema<S> = S extends StandardSchemaV1<any, infer Output> ? Output : unknown;

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type MaybePromise<T> = T | Promise<T>;
type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'TRACE';

type SegmentParams<S extends string> =
  S extends `${string}:${infer Param}/${infer Rest}`
    ? { [K in Param | keyof SegmentParams<`/${Rest}`>]: string }
    : S extends `${string}:${infer Param}`
      ? { [K in Param]: string }
      : S extends `${string}*/${infer Rest}`
        ? { '*' : string } & SegmentParams<`/${Rest}`>
        : S extends `${string}*`
          ? { '*': string }
          : {};

export type PathParams<Path extends string> = Simplify<SegmentParams<Path>>;

export interface FunctionalRequest<Path extends string = string> {
  readonly request: IncomingMessage;
  readonly method: string;
  readonly path: string;
  readonly route: Path;
  readonly params: PathParams<Path>;
  readonly query: Record<string, string | string[]>;
  readonly headers: IncomingHttpHeaders;
  readonly body: unknown;
}

type WithInput<
  Env,
  Spec extends InputSpec
> = Simplify<
  Omit<Env, 'body' | 'params' | 'query' | 'headers'> & {
    body: Spec['body'] extends StandardSchemaV1 ? InferSchema<Spec['body']> : Env extends { body: infer B } ? B : unknown;
    params: Spec['params'] extends StandardSchemaV1 ? InferSchema<Spec['params']> : Env extends { params: infer P } ? P : Record<string, string>;
    query: Spec['query'] extends StandardSchemaV1 ? InferSchema<Spec['query']> : Env extends { query: infer Q } ? Q : Record<string, string | string[]>;
    headers: Spec['headers'] extends StandardSchemaV1 ? InferSchema<Spec['headers']> : Env extends { headers: infer H } ? H : IncomingHttpHeaders;
  }
>;

type AddProvided<Env, Name extends string, Value> = Simplify<Env & { readonly [K in Name]: Value }>;

export interface InputSpec {
  readonly body?: StandardSchemaV1;
  readonly params?: StandardSchemaV1;
  readonly query?: StandardSchemaV1;
  readonly headers?: StandardSchemaV1;
}

export type ResponseSpec = Readonly<Record<number, StandardSchemaV1 | null>>;

export interface Reply<Status extends number = number, Body = unknown> {
  readonly status: Status;
  readonly body: Body;
  readonly headers?: Readonly<Record<string, string | number | readonly string[]>>;
}

type ReplyFor<Spec extends ResponseSpec> = {
  [Status in keyof Spec & number]:
    Spec[Status] extends StandardSchemaV1
      ? Reply<Status, InferSchema<Spec[Status]>>
      : Reply<Status, undefined>
}[keyof Spec & number];

type HandlerResult<Spec extends ResponseSpec> = keyof Spec extends never
  ? Reply | unknown
  : ReplyFor<Spec>;

export type FunctionalHandler<Env, Spec extends ResponseSpec> =
  (env: Readonly<Env>) => MaybePromise<HandlerResult<Spec>>;

export type TapPhase =
  | 'validated'
  | 'provided'
  | 'beforeHandler'
  | 'afterHandler'
  | 'beforeSend'
  | 'onResponse'
  | 'onError';

type FunctionalHook<Env = any> = (
  payload: {
    readonly phase: TapPhase;
    readonly input: Readonly<Env>;
    readonly reply?: Reply;
    readonly error?: Error;
  }
) => unknown | Promise<unknown>;

interface RuntimeInputEntry {
  part: keyof InputSpec;
  schema: StandardSchemaV1;
}

interface RuntimeProvider {
  name: string;
  provide: (env: any) => MaybePromise<unknown>;
}

interface RuntimeHook {
  phase: TapPhase;
  hook: FunctionalHook;
}

const ROUTE = Symbol.for('openmesh.functional-route');

export interface FunctionalRoute<
  Env = any,
  Responses extends ResponseSpec = {},
  Complete extends boolean = false
> {
  readonly [ROUTE]: true;
  readonly method: Method;
  readonly path: string;
  readonly inputEntries: readonly RuntimeInputEntry[];
  readonly providers: readonly RuntimeProvider[];
  readonly hooks: readonly RuntimeHook[];
  readonly responses: Responses;
  readonly handler: Complete extends true ? FunctionalHandler<Env, Responses> : FunctionalHandler<Env, Responses> | null;
  readonly __env?: Env;
  readonly __responses?: Responses;
  readonly __complete?: Complete;
}

function freezeRoute<Env, Responses extends ResponseSpec, Complete extends boolean>(
  route: Omit<FunctionalRoute<Env, Responses, Complete>, typeof ROUTE>
): FunctionalRoute<Env, Responses, Complete> {
  return Object.freeze({ ...route, [ROUTE]: true as const });
}

function seed<M extends Method, Path extends string>(
  method: M,
  path: Path
): FunctionalRoute<FunctionalRequest<Path>, {}, false> {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new TypeError('Functional route path must begin with /');
  }
  return freezeRoute({
    method,
    path,
    inputEntries: Object.freeze([]),
    providers: Object.freeze([]),
    hooks: Object.freeze([]),
    responses: Object.freeze({}),
    handler: null
  });
}

export const GET = <Path extends string>(path: Path) => seed('GET', path);
export const HEAD = <Path extends string>(path: Path) => seed('HEAD', path);
export const POST = <Path extends string>(path: Path) => seed('POST', path);
export const PUT = <Path extends string>(path: Path) => seed('PUT', path);
export const PATCH = <Path extends string>(path: Path) => seed('PATCH', path);
export const DELETE = <Path extends string>(path: Path) => seed('DELETE', path);
export const OPTIONS = <Path extends string>(path: Path) => seed('OPTIONS', path);
export const TRACE = <Path extends string>(path: Path) => seed('TRACE', path);

export type RouteOperator<A, B> = (route: A) => B;

export function pipe<A, B>(value: A, ab: (a: A) => B): B;
export function pipe<A, B, C>(value: A, ab: (a: A) => B, bc: (b: B) => C): C;
export function pipe<A, B, C, D>(value: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D): D;
export function pipe<A, B, C, D, E>(value: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E): E;
export function pipe<A, B, C, D, E, F>(value: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E, ef: (e: E) => F): F;
export function pipe<A, B, C, D, E, F, G>(value: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E, ef: (e: E) => F, fg: (f: F) => G): G;
export function pipe(value: unknown, ...operators: Array<(value: any) => any>): unknown {
  return operators.reduce((current, operator) => operator(current), value);
}

export function input<const Spec extends InputSpec>(spec: Spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError('input() expects a schema object');
  }

  return <Env, Responses extends ResponseSpec, Complete extends boolean>(
    route: FunctionalRoute<Env, Responses, Complete>
  ): FunctionalRoute<WithInput<Env, Spec>, Responses, Complete> => {
    const entries: RuntimeInputEntry[] = [...route.inputEntries];
    for (const part of ['params', 'query', 'headers', 'body'] as const) {
      const schema = spec[part];
      if (schema !== undefined) {
        assertSchema(schema, 'input.' + part);
        entries.push({ part, schema });
      }
    }
    return freezeRoute({
      ...route,
      inputEntries: Object.freeze(entries)
    }) as FunctionalRoute<WithInput<Env, Spec>, Responses, Complete>;
  };
}

export function provide<Name extends string, Env, Value>(
  name: Name,
  provider: (env: Readonly<Env>) => MaybePromise<Value>
): <Responses extends ResponseSpec, Complete extends boolean>(
  route: FunctionalRoute<Env, Responses, Complete>
) => FunctionalRoute<AddProvided<Env, Name, Value>, Responses, Complete>;
export function provide<Name extends string, Value>(
  name: Name,
  provider: (env: Readonly<any>) => MaybePromise<Value>
) {
  if (!name || typeof name !== 'string') throw new TypeError('provide() name must be nonempty');
  if (typeof provider !== 'function') throw new TypeError('provide() expects a function');
  return <Env, Responses extends ResponseSpec, Complete extends boolean>(
    route: FunctionalRoute<Env, Responses, Complete>
  ): FunctionalRoute<AddProvided<Env, Name, Value>, Responses, Complete> =>
    freezeRoute({
      ...route,
      providers: Object.freeze([...route.providers, { name, provide: provider }])
    }) as FunctionalRoute<AddProvided<Env, Name, Value>, Responses, Complete>;
}

export function returns<const Spec extends ResponseSpec>(spec: Spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError('returns() expects a response-schema map');
  }
  for (const [status, schema] of Object.entries(spec)) {
    const code = Number(status);
    if (!Number.isInteger(code) || code < 100 || code > 599) {
      throw new TypeError('Response status must be 100..599');
    }
    if (schema !== null) assertSchema(schema, 'returns.' + status);
  }

  return <Env, Previous extends ResponseSpec, Complete extends boolean>(
    route: FunctionalRoute<Env, Previous, Complete>
  ): FunctionalRoute<Env, Spec, Complete> =>
    freezeRoute<Env, Spec, Complete>({
      method: route.method,
      path: route.path,
      inputEntries: route.inputEntries,
      providers: route.providers,
      hooks: route.hooks,
      responses: Object.freeze({ ...spec }) as Spec,
      handler: route.handler as FunctionalRoute<Env, Spec, Complete>['handler']
    });
}

export function tap<Env>(
  phase: TapPhase,
  fn: FunctionalHook<Env>
) {
  const phases: readonly TapPhase[] = ['validated', 'provided', 'beforeHandler', 'afterHandler', 'beforeSend', 'onResponse', 'onError'];
  if (!phases.includes(phase)) throw new TypeError('Unknown functional tap phase: ' + phase);
  if (typeof fn !== 'function') throw new TypeError('tap() expects a function');

  return <Responses extends ResponseSpec, Complete extends boolean>(
    route: FunctionalRoute<Env, Responses, Complete>
  ): FunctionalRoute<Env, Responses, Complete> =>
    freezeRoute({
      ...route,
      hooks: Object.freeze([...route.hooks, { phase, hook: fn as FunctionalHook }])
    });
}

export type ProviderMap<Env> = Readonly<Record<string, (env: Readonly<Env>) => MaybePromise<unknown>>>;
export type ProvidedValues<Providers extends ProviderMap<any>> = {
  readonly [Name in keyof Providers]: Awaited<ReturnType<Providers[Name]>>
};

export interface FunctionalImplementation<
  Env,
  Responses extends ResponseSpec,
  Providers extends ProviderMap<Env>
> {
  readonly provide: Providers;
  readonly run: FunctionalHandler<Simplify<Env & ProvidedValues<Providers>>, Responses>;
}

export function implement<Env, Responses extends ResponseSpec>(
  route: FunctionalRoute<Env, Responses, false>,
  fn: FunctionalHandler<Env, Responses>
): FunctionalRoute<Env, Responses, true>;
export function implement<
  Env,
  Responses extends ResponseSpec,
  Providers extends ProviderMap<Env>
>(
  route: FunctionalRoute<Env, Responses, false>,
  implementation: FunctionalImplementation<Env, Responses, Providers>
): FunctionalRoute<Simplify<Env & ProvidedValues<Providers>>, Responses, true>;
export function implement<
  Env,
  Responses extends ResponseSpec,
  Providers extends ProviderMap<Env>
>(
  route: FunctionalRoute<Env, Responses, false>,
  implementation: FunctionalHandler<Env, Responses> | FunctionalImplementation<Env, Responses, Providers>
): FunctionalRoute<any, Responses, true> {
  if (!route || route[ROUTE] !== true) throw new TypeError('implement() expects a functional route contract');

  if (typeof implementation === 'function') {
    return freezeRoute<Env, Responses, true>({
      method: route.method,
      path: route.path,
      inputEntries: route.inputEntries,
      providers: route.providers,
      hooks: route.hooks,
      responses: route.responses,
      handler: implementation
    });
  }

  if (!implementation || typeof implementation !== 'object' || typeof implementation.run !== 'function') {
    throw new TypeError('implement() expects a handler function or { provide, run } object');
  }
  if (!implementation.provide || typeof implementation.provide !== 'object' || Array.isArray(implementation.provide)) {
    throw new TypeError('implement().provide must be an object');
  }

  const providers: RuntimeProvider[] = [...route.providers];
  for (const [name, provider] of Object.entries(implementation.provide)) {
    if (!name || typeof provider !== 'function') {
      throw new TypeError('implement().provide values must be functions');
    }
    providers.push({ name, provide: provider as (env: any) => MaybePromise<unknown> });
  }

  return freezeRoute<any, Responses, true>({
    method: route.method,
    path: route.path,
    inputEntries: route.inputEntries,
    providers: Object.freeze(providers),
    hooks: route.hooks,
    responses: route.responses,
    handler: implementation.run as FunctionalHandler<any, Responses>
  });
}

export const handle = implement;

export function reply<const Status extends number, Body>(
  status: Status,
  body: Body,
  headers?: Readonly<Record<string, string | number | readonly string[]>>
): Reply<Status, Body> {
  if (!Number.isInteger(status) || status < 100 || status > 599) throw new RangeError('Reply status must be 100..599');
  return Object.freeze({ status, body, ...(headers ? { headers } : {}) });
}

export const ok = <Body>(body: Body) => reply(200, body);
export const created = <Body>(body: Body) => reply(201, body);
export const accepted = <Body>(body: Body) => reply(202, body);
export const noContent = () => reply(204, undefined);

async function validate(
  schema: StandardSchemaV1,
  value: unknown,
  part: string,
  statusCode = 400
): Promise<unknown> {
  const code = statusCode >= 500 ? 'RESPONSE_VALIDATION_ERROR' : 'VALIDATION_ERROR';
  let result;
  try {
    result = await schema['~standard'].validate(value);
  } catch (cause) {
    throw new HttpError(statusCode, 'Validation failed for ' + part, { cause, code });
  }
  if ('issues' in result && result.issues) {
    const error = new HttpError(statusCode, 'Validation failed for ' + part, { code });
    error.validation = result.issues;
    throw error;
  }
  return result.value;
}

function assertSchema(value: unknown, label: string): asserts value is StandardSchemaV1 {
  const candidate = value as StandardSchemaV1 | undefined;
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    !candidate['~standard'] ||
    candidate['~standard'].version !== 1 ||
    typeof candidate['~standard'].validate !== 'function'
  ) {
    throw new TypeError(label + ' must implement Standard Schema v1');
  }
}

function isReply(value: unknown): value is Reply {
  return !!value && typeof value === 'object' && Number.isInteger((value as Reply).status) && 'body' in (value as Reply);
}

async function runHooks(
  route: FunctionalRoute<any, any, boolean>,
  phase: TapPhase,
  input: Readonly<any>,
  extras: { reply?: Reply; error?: Error } = {}
): Promise<void> {
  for (const entry of route.hooks) {
    if (entry.phase === phase) await entry.hook({ phase, input, ...extras });
  }
}

async function execute(route: FunctionalRoute<any, any, true>, ctx: Context): Promise<Context> {
  let env: Record<string, unknown> = {
    request: ctx.req,
    method: ctx.method || route.method,
    path: ctx.path,
    route: route.path,
    params: ctx.params,
    query: ctx.query,
    headers: ctx.headers,
    body: ctx.requestBody
  };

  try {
    for (const entry of route.inputEntries) {
      const value = await validate(entry.schema, env[entry.part], entry.part);
      env = { ...env, [entry.part]: value };
    }

    await runHooks(route, 'validated', env);

    for (const provider of route.providers) {
      const value = await provider.provide(Object.freeze(env));
      env = { ...env, [provider.name]: value };
    }

    env = Object.freeze(env);
    await runHooks(route, 'provided', env);
    await runHooks(route, 'beforeHandler', env);

    const returned = await route.handler!(env);
    const functionalReply = isReply(returned) ? returned : reply(200, returned);

    await runHooks(route, 'afterHandler', env, { reply: functionalReply });

    const declaredStatuses = Object.keys(route.responses);
    if (declaredStatuses.length && !Object.hasOwn(route.responses, functionalReply.status)) {
      throw new HttpError(500, 'Functional handler returned undeclared status ' + functionalReply.status, {
        code: 'UNDECLARED_RESPONSE_STATUS'
      });
    }

    const schema = route.responses[functionalReply.status];
    let body = functionalReply.body;
    if (schema) body = await validate(schema, body, 'response.' + functionalReply.status, 500);

    const finalReply = body === functionalReply.body
      ? functionalReply
      : reply(functionalReply.status, body, functionalReply.headers);

    ctx.status = finalReply.status;
    if (finalReply.headers) ctx.set(finalReply.headers);
    ctx.body = finalReply.body;

    await runHooks(route, 'beforeSend', env, { reply: finalReply });

    if (route.hooks.some(entry => entry.phase === 'onResponse')) {
      ctx.res.once('finish', () => {
        void runHooks(route, 'onResponse', env, { reply: finalReply });
      });
    }

    return ctx;
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error('Functional route failed', { cause: error });
    try { await runHooks(route, 'onError', env, { error: normalized }); } catch {}
    throw normalized;
  }
}

export type FunctionalApi<
  Routes extends readonly FunctionalRoute<any, any, true>[] = readonly FunctionalRoute<any, any, true>[]
> = Plugin & {
  readonly prefix: string;
  readonly routes: Routes;
};

export function api<const Routes extends readonly FunctionalRoute<any, any, true>[]>(
  ...routes: Routes
): FunctionalApi<Routes>;
export function api<
  const Prefix extends string,
  const Routes extends readonly FunctionalRoute<any, any, true>[]
>(
  prefix: Prefix,
  ...routes: Routes
): FunctionalApi<Routes>;
export function api(
  prefixOrRoute: string | FunctionalRoute<any, any, true>,
  ...rest: readonly FunctionalRoute<any, any, true>[]
): FunctionalApi {
  const prefix = typeof prefixOrRoute === 'string' ? prefixOrRoute : '';
  const routes = (typeof prefixOrRoute === 'string' ? rest : [prefixOrRoute, ...rest]) as readonly FunctionalRoute<any, any, true>[];

  if (prefix && (!prefix.startsWith('/') || /[?#:*]/.test(prefix))) {
    throw new TypeError('api() prefix must be a literal path beginning with /');
  }
  if (!routes.length) throw new TypeError('api() requires at least one functional route');
  for (const route of routes) {
    if (!route || route[ROUTE] !== true || typeof route.handler !== 'function') {
      throw new TypeError('api() accepts completed functional routes');
    }
  }

  const install: Plugin = app => {
    for (const route of routes) {
      app.route(route.method, route.path, ctx => execute(route, ctx));
    }
  };

  const functionalApi: Plugin = prefix
    ? (app, options, done) => {
        app.register(install, { ...options, prefix });
        done();
      }
    : install;

  Object.defineProperties(functionalApi, {
    prefix: { value: prefix, enumerable: true },
    routes: { value: Object.freeze([...routes]), enumerable: true }
  });

  return functionalApi as FunctionalApi;
}
