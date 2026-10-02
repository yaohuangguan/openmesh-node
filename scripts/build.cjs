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
`);

writeFileSync(path.join(root, 'dist', 'types', 'index.d.mts'), `export * from './index.js';
import { openmesh } from './index.js';
export default openmesh;
`);
for (const subpath of ['plugins', 'mesh', 'services']) {
  writeFileSync(path.join(root, 'dist', 'types', subpath, 'index.d.mts'), `export * from './index.js';\n`);
}

console.log('Built OpenMesh: CJS + ESM + declarations');
