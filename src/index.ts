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
  MeshIdentityOptions,
  WorkloadIdentityOptions,
  WorkloadIdentityMaterial,
  WorkloadIdentityRotationOptions
} from './services/index.js';
import { workloadIdentityUri } from './security/identity.js';

export interface OpenMeshOptions extends AppOptions {
  service?: string;
  identity?: WorkloadIdentityOptions;
  mesh?: MeshRuntimeOptions;
}

export interface WorkloadRuntime {
  readonly id: string;
  readonly service: string;
  readonly trustDomain: string;
  rotate(
    material: WorkloadIdentityMaterial,
    options?: WorkloadIdentityRotationOptions
  ): Promise<void>;
}

export type MeshedOpenMesh = OpenMesh & {
  mesh: MeshAccessor;
};

export type IdentifiedOpenMesh = OpenMesh & {
  workload: WorkloadRuntime;
};

export type IdentifiedMeshedOpenMesh = MeshedOpenMesh & {
  workload: WorkloadRuntime;
};

export function openmesh(
  options: OpenMeshOptions & { identity: WorkloadIdentityOptions; mesh: MeshRuntimeOptions }
): IdentifiedMeshedOpenMesh;
export function openmesh(
  options: OpenMeshOptions & { identity: WorkloadIdentityOptions }
): IdentifiedOpenMesh;
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
  let meshIdentity: MeshIdentityOptions | undefined;

  if (identity && service) {
    if (appOptions.tls?.SNICallback) {
      throw new TypeError('workload identity cannot be combined with a custom TLS SNICallback');
    }

    meshIdentity = {
      trustDomain: identity.trustDomain,
      service,
      ca: identity.ca,
      cert: identity.cert,
      key: identity.key,
      ...(identity.passphrase !== undefined ? { passphrase: identity.passphrase } : {}),
      ...(identity.minVersion !== undefined ? { minVersion: identity.minVersion } : {})
    };
    validateMeshIdentityOptions(meshIdentity);

    appOptions.tls = {
      ...(appOptions.tls || {}),
      ca: identity.ca,
      cert: identity.cert,
      key: identity.key,
      ...(identity.passphrase !== undefined ? { passphrase: identity.passphrase } : {}),
      minVersion: identity.minVersion ?? 'TLSv1.3',
      requestCert: true,
      rejectUnauthorized: true
    };

    if (mesh) meshOptions = { ...mesh, identity: meshIdentity };
  }

  const app = new OpenMesh(appOptions);
  if (service) app.use(requestContext({ service }));
  if (identity) app.use(workloadIdentity({ trustDomain: identity.trustDomain, allow: identity.allow }));

  const meshAccessor = meshOptions ? attachMeshRuntime(app, meshOptions) : undefined;

  if (identity && service && meshIdentity) {
    let currentIdentity = meshIdentity;
    const runtime: WorkloadRuntime = {
      id: workloadIdentityUri(identity.trustDomain, service),
      service,
      trustDomain: identity.trustDomain,

      async rotate(material, rotationOptions = {}) {
        const previous = currentIdentity;
        const next: MeshIdentityOptions = {
          ...currentIdentity,
          ...material
        };
        validateMeshIdentityOptions(next);

        const previousMaterial: WorkloadIdentityMaterial = {
          ca: previous.ca,
          cert: previous.cert,
          key: previous.key,
          ...(previous.passphrase !== undefined ? { passphrase: previous.passphrase } : {})
        };

        if (meshAccessor) {
          await meshAccessor.runtime.rotateIdentity(material, rotationOptions);
        }

        try {
          app._updateTlsContext({
            ca: next.ca,
            cert: next.cert,
            key: next.key,
            ...(next.passphrase !== undefined ? { passphrase: next.passphrase } : {}),
            minVersion: next.minVersion ?? 'TLSv1.3',
            requestCert: true,
            rejectUnauthorized: true
          });
        } catch (error) {
          if (meshAccessor) {
            await meshAccessor.runtime.rotateIdentity(previousMaterial, { graceMs: 0 }).catch(() => {});
          }
          throw error;
        }

        currentIdentity = next;
      }
    };

    app.decorate('workload', Object.freeze(runtime));
  }

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
  WorkloadIdentityMaterial,
  WorkloadIdentityRotationOptions,
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
