import { OpenMesh, definePlugin } from './core/app.js';
import { Context, HttpError } from './core/context.js';
import type { AppOptions } from './core/app.js';

export function openmesh(options?: AppOptions): OpenMesh {
  return new OpenMesh(options);
}

export default openmesh;
export { OpenMesh, Context, HttpError, definePlugin };
export type {
  Next,
  Middleware,
  Handler,
  ExpressMiddleware,
  RouteSchema,
  RouteHooks,
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
