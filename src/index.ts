import { OpenMesh, definePlugin } from './core/app.js';
import { Context, HttpError } from './core/context.js';
import type { AppOptions } from './core/app.js';
import { attachMeshRuntime, MeshHttpError } from './services/index.js';
import { requestContext } from './plugins/index.js';
export { reply, ok, created, accepted, noContent } from './http/index.js';
import type { MeshRuntimeOptions, MeshAccessor } from './services/index.js';

export interface OpenMeshOptions extends AppOptions {
  service?: string;
  mesh?: MeshRuntimeOptions;
}

export type MeshedOpenMesh = OpenMesh & {
  mesh: MeshAccessor;
};

export function openmesh(options: OpenMeshOptions & { mesh: MeshRuntimeOptions }): MeshedOpenMesh;
export function openmesh(options?: OpenMeshOptions): OpenMesh;
export function openmesh(options: OpenMeshOptions = {}): OpenMesh {
  const { mesh, service, ...appOptions } = options;
  if (service !== undefined && (typeof service !== 'string' || !service.trim())) {
    throw new TypeError('service must be a nonempty string');
  }

  const app = new OpenMesh(appOptions);
  if (service) app.use(requestContext({ service }));
  if (mesh) attachMeshRuntime(app, mesh);
  return app;
}

export default openmesh;
export { OpenMesh, Context, HttpError, MeshHttpError, definePlugin };
export type {
  Next,
  Middleware,
  Handler,
  ExpressMiddleware,
  RouteSchema,
  RouteHooks,
  StandardSchemaV1,
  InferStandardSchema,
  PathParams,
  HttpReply,
  TypedRouteOptions,
  TypedRouteInput,
  TypedRouteResult,
  TypedRouteHandler,
  HookName,
  RequestHook,
  ValueHook,
  ErrorHook,
  Validator,
  ValidatorCompiler,
  SerializerCompiler,
  RouteOptions,
  ServerLimits,
  AppEvent,
  AppObserver,
  AppOptions,
  PluginOptions,
  Plugin,
  RouteMethod
} from './core/app.js';
export type {
  MeshRuntimeOptions,
  MeshAccessor,
  MeshServiceOptions,
  MeshTrafficPolicy,
  MeshTrafficTarget,
  MeshTrafficWhen,
  MeshTrafficRoute,
  MeshTrafficPreference,
  MeshMetadataMatch,
  MeshRawRequestOptions,
  MeshStreamRequestOptions,
  MeshRequestOptions,
  MeshWriteOptions
} from './services/index.js';
