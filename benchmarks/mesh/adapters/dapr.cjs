'use strict';

const http = require('node:http');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');

const DAPR_BIN = process.env.DAPR_BIN || 'daprd';
const BACKENDS = 3;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

function httpJson(agent, url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { agent }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => {
        const status = response.statusCode || 500;
        if (status < 200 || status >= 300) {
          reject(new Error('HTTP ' + status + ' from ' + url + ': ' + Buffer.concat(chunks).toString('utf8')));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once('error', reject);
  });
}

function httpOk(agent, url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { agent }, response => {
      response.resume();
      response.once('end', () => resolve((response.statusCode || 500) >= 200 && (response.statusCode || 500) < 300));
    });
    request.once('error', reject);
  });
}

async function waitFor(check, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message + (lastError ? ': ' + lastError.message : ''));
}

function spawnDaprd({ appId, appPort, httpPort, grpcPort, internalGrpcPort }) {
  const args = [
    '--app-id', appId,
    '--dapr-http-port', String(httpPort),
    '--dapr-grpc-port', String(grpcPort),
    '--dapr-internal-grpc-port', String(internalGrpcPort),
    '--dapr-listen-addresses', '127.0.0.1',
    '--log-level', 'error',
    '--enable-metrics=false'
  ];
  if (appPort) args.push('--app-port', String(appPort), '--app-protocol', 'http');

  const child = spawn(DAPR_BIN, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  });
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-10000); });
  child.once('exit', code => {
    if (code && code !== 0) diagnostics += '\ndaprd exited with code ' + code;
  });
  child.diagnostics = () => diagnostics;
  return child;
}

function rssBytes(pids) {
  try {
    const output = execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' });
    return output.trim().split(/\s+/).filter(Boolean).reduce((sum, value) => sum + Number(value) * 1024, 0);
  } catch {
    return null;
  }
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 3000))
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function main() {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 4096 });
  const backendServers = [];
  const sidecars = [];
  const backendUrls = [];

  for (let index = 0; index < BACKENDS; index += 1) {
    const instance = 'backend-' + String.fromCharCode(97 + index);
    const server = http.createServer((request, response) => {
      if ((request.url || '/').split('?')[0] !== '/work') {
        response.statusCode = 404;
        response.end();
        return;
      }
      const body = JSON.stringify({ ok: true, instance });
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.setHeader('content-length', Buffer.byteLength(body));
      response.end(body);
    });
    const appPort = await listen(server);
    backendServers.push(server);
    backendUrls.push('http://127.0.0.1:' + appPort + '/work');

    const httpPort = await freePort();
    const grpcPort = await freePort();
    const internalGrpcPort = await freePort();
    const sidecar = spawnDaprd({
      appId: 'bench-worker',
      appPort,
      httpPort,
      grpcPort,
      internalGrpcPort
    });
    sidecar.httpPort = httpPort;
    sidecars.push(sidecar);
  }

  let gatewayDaprUrl = null;
  const gateway = http.createServer(async (request, response) => {
    const path = (request.url || '/').split('?')[0];

    try {
      let data;
      if (path === '/health') {
        data = { ok: true };
      } else if (path === '/direct') {
        data = await httpJson(agent, backendUrls[0]);
      } else if (path === '/mesh') {
        data = await httpJson(agent, gatewayDaprUrl + '/v1.0/invoke/bench-worker/method/work');
      } else {
        response.statusCode = 404;
        response.end();
        return;
      }

      const body = JSON.stringify(data);
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.setHeader('content-length', Buffer.byteLength(body));
      response.end(body);
    } catch (error) {
      response.statusCode = 502;
      const body = JSON.stringify({ error: error.message });
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(body);
    }
  });

  const gatewayPort = await listen(gateway);
  const gatewayHttpPort = await freePort();
  const gatewayGrpcPort = await freePort();
  const gatewayInternalGrpcPort = await freePort();
  const gatewaySidecar = spawnDaprd({
    appId: 'bench-gateway',
    appPort: gatewayPort,
    httpPort: gatewayHttpPort,
    grpcPort: gatewayGrpcPort,
    internalGrpcPort: gatewayInternalGrpcPort
  });
  gatewaySidecar.httpPort = gatewayHttpPort;
  sidecars.push(gatewaySidecar);
  gatewayDaprUrl = 'http://127.0.0.1:' + gatewayHttpPort;

  for (const sidecar of sidecars) {
    await waitFor(
      () => httpOk(agent, 'http://127.0.0.1:' + sidecar.httpPort + '/v1.0/healthz/outbound').catch(() => false),
      'Dapr sidecar did not become ready' + (sidecar.diagnostics() ? ': ' + sidecar.diagnostics() : '')
    );
  }

  await waitFor(
    () => httpJson(agent, gatewayDaprUrl + '/v1.0/invoke/bench-worker/method/work').catch(() => null),
    'Dapr service invocation did not become ready'
  );

  const pids = [process.pid, ...sidecars.map(child => child.pid).filter(Boolean)];
  const ready = {
    system: 'dapr',
    version: process.env.DAPR_VERSION || '1.18.x',
    language: 'go-sidecar',
    pid: process.pid,
    capabilities: {
      direct: true,
      mesh: true,
      policy: false,
      mtlsInThisAdapter: false
    },
    endpoints: {
      direct: 'http://127.0.0.1:' + gatewayPort + '/direct',
      mesh: 'http://127.0.0.1:' + gatewayPort + '/mesh',
      health: 'http://127.0.0.1:' + gatewayPort + '/health'
    },
    topology: { backends: BACKENDS, sidecars: BACKENDS + 1 },
    rssBytes: rssBytes(pids)
  };

  if (process.send) process.send(ready);
  else process.stdout.write(JSON.stringify(ready) + '\n');

  const close = async () => {
    agent.destroy();
    await Promise.all(sidecars.map(stop));
    await Promise.all(backendServers.map(server => new Promise(resolve => server.close(resolve))));
    await new Promise(resolve => gateway.close(resolve));
  };

  process.on('message', async message => {
    if (message === 'stats' && process.send) {
      process.send({ type: 'stats', rssBytes: rssBytes(pids) });
      return;
    }
    if (message === 'close') {
      await close();
      process.disconnect?.();
    }
  });

  process.once('SIGTERM', async () => {
    await close();
    process.exit(0);
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
  process.disconnect?.();
});
