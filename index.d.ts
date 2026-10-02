import type { IncomingMessage, ServerResponse, Server, ServerOptions } from 'node:http';
import type { AddressInfo, ListenOptions } from 'node:net';
export type Next = () => Promise<unknown>;
export type Middleware = (ctx: Context, next: Next) => unknown | Promise<unknown>;
export type Handler = (ctx: Context) => unknown | Promise<unknown>;
export type ExpressMiddleware = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => unknown;
export interface RouteSchema { body?: unknown; querystring?: unknown; params?: unknown; headers?: unknown; response?: Record<string, unknown>; }
export type Validator = ((value: unknown) => boolean | { error?: unknown } | Promise<boolean | { error?: unknown }>) & { errors?: unknown };
export type ValidatorCompiler = (context: { schema: unknown; method: string; url: string; httpPart: 'body' | 'querystring' | 'params' | 'headers' }) => Validator;
export type SerializerCompiler = (context: { schema: unknown; method: string; url: string; httpStatus: string }) => (body: unknown) => string | Buffer;
export interface RouteOptions { middleware?: Middleware | Middleware[]; serializer?: (body: unknown) => string | Buffer; schema?: RouteSchema; }
export interface ServerLimits { requestTimeout?: number; headersTimeout?: number; keepAliveTimeout?: number; maxHeadersCount?: number; }
export interface AppOptions { pluginTimeout?: number; shutdownTimeout?: number; server?: ServerOptions; serverLimits?: ServerLimits; validatorCompiler?: ValidatorCompiler; serializerCompiler?: SerializerCompiler; }
export interface PluginOptions { prefix?: string; [key: string]: unknown; }
export type Plugin = (app: OpenMesh, options: PluginOptions, done: (error?: Error) => void) => void | Promise<void>;
export class HttpError extends Error { statusCode: number; expose: boolean; code: string; constructor(statusCode: number, message?: string, options?: ErrorOptions & { code?: string }); }
export class Context {
  req: IncomingMessage & { body?: unknown; originalUrl?: string };
  res: ServerResponse; app: OpenMesh; path: string; route: unknown;
  readonly request: Context['req']; readonly response: ServerResponse;
  readonly method: string | undefined; readonly url: string | undefined; readonly headers: IncomingMessage['headers'];
  readonly params: Record<string, string>; readonly query: Record<string, string | string[]>;
  readonly state: Record<string, any>; readonly requestBody: unknown;
  status: number; body: unknown;
  get(name: string): string | string[] | undefined;
  set(name: string, value: string | number | readonly string[]): this;
  set(headers: Record<string, string | number | readonly string[]>): this;
  send(body: unknown): this; json(body: unknown): this; redirect(location: string, status?: number): this; throw(status: number, message?: string): never;
}
export class OpenMesh {
  constructor(options?: AppOptions);
  readonly server: Server | null; readonly phase: string; readonly prefix: string; readonly version: string;
  use(middleware: Middleware): this; useExpress(middleware: ExpressMiddleware): this;
  route(method: string, path: string, handler: Handler): this;
  route(method: string, path: string, options: RouteOptions, handler: Handler): this;
  get: RouteMethod; head: RouteMethod; post: RouteMethod; put: RouteMethod; patch: RouteMethod; delete: RouteMethod; options: RouteMethod; trace: RouteMethod; all: RouteMethod;
  register(plugin: Plugin, options?: PluginOptions): this;
  setValidatorCompiler(compiler: ValidatorCompiler): this;
  setSerializerCompiler(compiler: SerializerCompiler): this;
  decorate(name: string, value: unknown): this; hasPlugin(name: string): boolean;
  onShutdown(hook: (app: OpenMesh) => void | Promise<void>): this;
  onClose(hook: (app: OpenMesh) => void | Promise<void>): this;
  onListen(hook: (app: OpenMesh, address: AddressInfo | string | null) => void | Promise<void>): this;
  setErrorHandler(handler: (error: Error, ctx: Context) => unknown | Promise<unknown>): this;
  setNotFoundHandler(handler: Handler): this;
  mount(prefix: string, handler: ExpressMiddleware, options?: { close?: () => void | Promise<void> }): this;
  fastify(prefix: string, plugin: (app: any, options: any, done: (error?: Error) => void) => void | Promise<void>, options?: { server?: Record<string, unknown>; plugin?: Record<string, unknown> }): this;
  ready(): Promise<this>; callback(): (req: IncomingMessage, res: ServerResponse) => void;
  listen(options?: ListenOptions | number): Promise<AddressInfo | string | null>;
  close(options?: { timeout?: number }): Promise<void>;
}
export interface RouteMethod { (path: string, handler: Handler): OpenMesh; (path: string, options: RouteOptions, handler: Handler): OpenMesh; }
export function definePlugin(plugin: Plugin, metadata?: { name?: string; global?: boolean; dependencies?: string[] }): Plugin;
export function openmesh(options?: AppOptions): OpenMesh;
export default openmesh;
