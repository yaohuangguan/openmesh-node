'use strict';
const { rmSync, mkdirSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tsc = path.join(path.dirname(require.resolve('typescript')), 'tsc.js');

rmSync(path.join(root, 'dist'), { recursive: true, force: true });

for (const config of ['tsconfig.cjs.json', 'tsconfig.esm.json', 'tsconfig.types.json']) {
  const result = spawnSync(process.execPath, [tsc, '-p', config], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

mkdirSync(path.join(root, 'dist', 'cjs'), { recursive: true });
mkdirSync(path.join(root, 'dist', 'esm'), { recursive: true });
mkdirSync(path.join(root, 'dist', 'types'), { recursive: true });

writeFileSync(path.join(root, 'dist', 'cjs', 'package.json'), '{"type":"commonjs"}\n');
writeFileSync(path.join(root, 'dist', 'esm', 'package.json'), '{"type":"module"}\n');

writeFileSync(path.join(root, 'dist', 'index.cjs'), `'use strict';
const api = require('./cjs/index.js');
const openmesh = api.openmesh || api.default;
module.exports = openmesh;
Object.assign(module.exports, api, { default: openmesh, openmesh });
`);

writeFileSync(path.join(root, 'dist', 'types', 'index.d.cts'), `import type * as Types from './index.js';
declare function openmesh(options: Types.OpenMeshOptions & { mesh: Types.MeshRuntimeOptions }): Types.MeshedOpenMesh;
declare function openmesh(options?: Types.OpenMeshOptions): Types.OpenMesh;
declare namespace openmesh {
  type Context = Types.Context;
  type Middleware = Types.Middleware;
  type Handler = Types.Handler;
  type Plugin = Types.Plugin;
  type AppOptions = Types.AppOptions;
  type OpenMeshOptions = Types.OpenMeshOptions;
  type MeshRuntimeOptions = Types.MeshRuntimeOptions;
  type MeshTrafficPolicy = Types.MeshTrafficPolicy;
  type MeshTrafficRoute = Types.MeshTrafficRoute;
  type MeshTrafficWhen = Types.MeshTrafficWhen;
  type MeshedOpenMesh = Types.MeshedOpenMesh;
  type TypedRouteOptions = Types.TypedRouteOptions;
  type StandardSchemaV1<Input = unknown, Output = Input> = Types.StandardSchemaV1<Input, Output>;
  const OpenMesh: typeof Types.OpenMesh;
  const Context: typeof Types.Context;
  const HttpError: typeof Types.HttpError;
  const MeshHttpError: typeof Types.MeshHttpError;
  const definePlugin: typeof Types.definePlugin;
  const reply: typeof Types.reply;
  const ok: typeof Types.ok;
  const created: typeof Types.created;
  const accepted: typeof Types.accepted;
  const noContent: typeof Types.noContent;
  const openmesh: typeof Types.openmesh;
}
export = openmesh;
`);

writeFileSync(path.join(root, 'dist', 'types', 'index.d.mts'), `export * from './index.js';
import { openmesh } from './index.js';
export default openmesh;
`);
for (const subpath of ['plugins', 'http', 'mesh', 'services', 'services/testing', 'services/redis', 'otel']) {
  writeFileSync(path.join(root, 'dist', 'types', subpath, 'index.d.mts'), `export * from './index.js';\n`);
}

console.log('Built OpenMesh: CJS + ESM + declarations');
