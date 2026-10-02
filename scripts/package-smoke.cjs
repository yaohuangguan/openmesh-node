'use strict';

const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const node = process.execPath;
const npmCli = process.env.npm_execpath;
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const temp = mkdtempSync(path.join(tmpdir(), 'openmesh-package-smoke-'));
let tarball;

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd || root,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    env: process.env,
    shell: options.shell || false
  });
}

function runNpm(args, options = {}) {
  if (npmCli) return run(node, [npmCli, ...args], options);
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    ...options,
    shell: process.platform === 'win32'
  });
}

try {
  const packed = runNpm(['pack', '--ignore-scripts', '--silent'], { capture: true });
  const filename = packed
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .reverse()
    .find(line => line.endsWith('.tgz'));
  if (!filename) throw new Error('npm pack did not return a tarball filename');
  tarball = path.join(root, filename);

  writeFileSync(path.join(temp, 'package.json'), JSON.stringify({
    name: 'openmesh-package-smoke',
    private: true,
    version: '0.0.0'
  }));

  runNpm([
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--no-save',
    tarball
  ], { cwd: temp });

  const subpaths = [
    'openmesh-node',
    'openmesh-node/plugins',
    'openmesh-node/mesh',
    'openmesh-node/services',
    'openmesh-node/services/testing',
    'openmesh-node/services/redis',
    'openmesh-node/otel'
  ];

  const cjs = `
    const paths = ${JSON.stringify(subpaths)};
    for (const name of paths) {
      const loaded = require(name);
      if (!loaded) throw new Error('CJS import returned no value for ' + name);
    }
    const packageJson = require('openmesh-node/package.json');
    if (packageJson.version !== ${JSON.stringify(pkg.version)}) {
      throw new Error('Installed package version mismatch: ' + packageJson.version);
    }
    const app = require('openmesh-node')();
    if (app.version !== packageJson.version) {
      throw new Error('Runtime version mismatch: ' + app.version + ' != ' + packageJson.version);
    }
  `;
  run(node, ['-e', cjs], { cwd: temp });

  const esm = `
    const paths = ${JSON.stringify(subpaths)};
    for (const name of paths) {
      const loaded = await import(name);
      if (!loaded) throw new Error('ESM import returned no value for ' + name);
    }
    const packageJson = await import('openmesh-node/package.json', { with: { type: 'json' } });
    if (packageJson.default.version !== ${JSON.stringify(pkg.version)}) {
      throw new Error('Installed package version mismatch: ' + packageJson.default.version);
    }
  `;
  run(node, ['--input-type=module', '-e', esm], { cwd: temp });

  console.log('Package smoke test passed for openmesh-node@' + pkg.version);
} finally {
  if (tarball) rmSync(tarball, { force: true });
  rmSync(temp, { recursive: true, force: true });
}
