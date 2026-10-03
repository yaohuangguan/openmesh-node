import { OpenMesh, definePlugin } from './core/app.js';
import { Context, HttpError } from './core/context.js';
import type { AppOptions } from './core/app.js';
import {
  attachMeshRuntime,
  MeshHttpError,
  validateMeshIdentityOptions,
  workloadIdentity
} from './services/index.js';
import { requestContext } from './plugins/index.js';
export { reply, ok, created, accepted, noContent } from './http/index.js';
import type {
  MeshRuntimeOptions,
  MeshAccessor,
  WorkloadIdentityOptions
} from './services/index.js';

export interface OpenMeshOptions extends AppOptions {
  service?: string;
  identity?: WorkloadIdentityOptions;
  mesh?: MeshRuntimeOptions;
}

export type MeshedOpenMesh = OpenMesh & {
  mesh: MeshAccessor;
};

export function openmesh(options: OpenMeshOptions & { mesh: MeshRuntimeOptions }): MeshedOpenMesh;
export function openmesh(options?: OpenMeshOptions): OpenMesh;
export function openmesh(options: OpenMeshOptions = {}): OpenMesh {
  const { mesh, service, identity, ...appOptions } = options;
  if (service !== undefined && (typeof service !== 'string' || !service.trim())) {
    throw new TypeError('service must be a nonempty string');
  }
  if (identity && !service) {
    throw new TypeError('workload identity requires a service name');
  }
  if (identity && mesh?.identity) {
    throw new TypeError('configure workload identity once at the OpenMesh application level');
  }

  let meshOptions = mesh;
  if (identity && service) {
    if (appOptions.tls?.SNICallback) {
      throw new TypeError('workload identity cannot be combined with a custom TLS SNICallback');
    }

    const meshIdentity = {
      trustDomain: identity.trustDomain,
      service,
      ca: identity.ca,
      cert: identity.cert,
      key: identity.key,
      ...(identity.passphrase ? { passphrase: identity.passphrase } : {}),
      ...(identity.minVersion ? { minVersion: identity.minVersion } : {})
    };
    validateMeshIdentityOptions(meshIdentity);

    appOptions.tls = {
      ...(appOptions.tls || {}),
      ca: identity.ca,
      cert: identity.cert,
      key: identity.key,
      ...(identity.passphrase ? { passphrase: identity.passphrase } : {}),
      minVersion: identity.minVersion ?? 'TLSv1.3',
      requestCert: true,
      rejectUnauthorized: true
    };

    if (mesh) meshOptions = { ...mesh, identity: meshIdentity };
  }

  const app = new OpenMesh(appOptions);
  if (service) app.use(requestContext({ service }));
  if (identity) app.use(workloadIdentity({ trustDomain: identity.trustDomain, allow: identity.allow }));
  if (meshOptions) attachMeshRuntime(app, meshOptions);
  return app;
}

export default openmesh;
export { OpenMesh, Context, HttpError, MeshHttpError, definePlugin, workloadIdentity };
export type { ContextState } from './core/context.js';
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
  MeshIdentityOptions,
  WorkloadIdentityOptions,
  WorkloadAuthorizerOptions,
  WorkloadCertificateAuthority,
  MeshTrafficPolicy,
  MeshTrafficTarget,
  MeshTrafficWhen,
  MeshTrafficRoute,
  MeshTrafficPreference,
  MeshTrafficConfigOptions,
  MeshMetadataMatch,
  MeshRawRequestOptions,
  MeshStreamRequestOptions,
  MeshRequestOptions,
  MeshWriteOptions
} from './services/index.js';
