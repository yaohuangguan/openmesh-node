import type * as Types from './index.js';
declare function openmesh(options?: Types.AppOptions): Types.OpenMesh;
declare namespace openmesh {
  type Context = Types.Context;
  type Middleware = Types.Middleware;
  type Handler = Types.Handler;
  type Plugin = Types.Plugin;
  type AppOptions = Types.AppOptions;
  const OpenMesh: typeof Types.OpenMesh;
  const Context: typeof Types.Context;
  const HttpError: typeof Types.HttpError;
  const definePlugin: typeof Types.definePlugin;
  const openmesh: typeof Types.openmesh;
}
export = openmesh;
