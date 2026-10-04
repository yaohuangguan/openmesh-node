'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const openmesh = require('openmesh-node');
const { controlPlane, ControlClient } = require('openmesh-node/services');

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const index = arg.indexOf('=');
  if (!arg.startsWith('--') || index < 0) throw new Error('Expected --name=value');
  return [arg.slice(2, index), arg.slice(index + 1)];
}));

const rounds = Number(args.rounds || 2);
const durationMs = Number(args.duration || 2) * 1000;
const warmupMs = Number(args.warmup || 1) * 1000;
const concurrency = Number(args.connections || 32);
const envoyImage = args['envoy-image'] || 'envoyproxy/envoy:v1.31-latest';
const output = path.resolve(process.cwd(), args.output || 'benchmarks/results/mesh-ci.json');

for (const [name, value] of Object.entries({ rounds, durationMs, warmupMs, concurrency })) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(name + ' must be positive');
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
};

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startTargets(count) {
  const targets = [];
  for (let index = 0; index < count; index++) {
    const id = 'target-' + index;
    const body = Buffer.from(JSON.stringify({ ok: true, id }));
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': body.byteLength,
        'x-bench-target': id
      });
      res.end(body);
    });
    const port = await listen(server);
    targets.push({
      id,
      port,
      url: 'http://127.0.0.1:' + port,
      close: () => new Promise(resolve => server.close(resolve))
    });
  }
  return targets;
}

async function closeTargets(targets) {
  await Promise.allSettled(targets.map(target => target.close()));
}

async function measure(request, { duration = durationMs, warmup = warmupMs, connections = concurrency } = {}) {
  const warmEnd = performance.now() + warmup;
  async function warmWorker() {
    while (performance.now() < warmEnd) {
      try { await request(); } catch {}
    }
  }
  await Promise.all(Array.from({ length: connections }, warmWorker));

  const latencies = [];
  let success = 0;
  let errors = 0;
  const started = performance.now();
  const end = started + duration;

  async function worker() {
    while (performance.now() < end) {
      const before = performance.now();
      try {
        await request();
        success++;
        latencies.push(performance.now() - before);
      } catch {
        errors++;
      }
    }
  }

  await Promise.all(Array.from({ length: connections }, worker));
  const elapsed = (performance.now() - started) / 1000;
  return {
    success,
    errors,
    rps: success / elapsed,
    p50Ms: percentile(latencies, 0.50),
    p99Ms: percentile(latencies, 0.99)
  };
}

async function measureFailure(request, injectFailure, {
  duration = 3000,
  injectAfter = 500,
  connections = concurrency
} = {}) {
  const warmEnd = performance.now() + warmupMs;
  async function warmWorker() {
    while (performance.now() < warmEnd) {
      try { await request(); } catch {}
    }
  }
  await Promise.all(Array.from({ length: connections }, warmWorker));

  const latencies = [];
  let success = 0;
  let errors = 0;
  let afterSuccess = 0;
  let afterErrors = 0;
  let lastErrorAfterInjectionMs = 0;
  const started = performance.now();
  const injectedAt = started + injectAfter;
  const end = started + duration;
  let injected = false;

  const timer = setTimeout(() => {
    injected = true;
    Promise.resolve(injectFailure()).catch(() => {});
  }, injectAfter);

  async function worker() {
    while (performance.now() < end) {
      const before = performance.now();
      try {
        await request();
        success++;
        latencies.push(performance.now() - before);
        if (performance.now() >= injectedAt) afterSuccess++;
      } catch {
        errors++;
        if (performance.now() >= injectedAt) {
          afterErrors++;
          lastErrorAfterInjectionMs = Math.max(lastErrorAfterInjectionMs, performance.now() - injectedAt);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: connections }, worker));
  clearTimeout(timer);
  const elapsed = (performance.now() - started) / 1000;
  return {
    success,
    errors,
    rps: success / elapsed,
    p50Ms: percentile(latencies, 0.50),
    p99Ms: percentile(latencies, 0.99),
    injected,
    afterSuccess,
    afterErrors,
    errorRateAfterInjection: afterErrors / Math.max(1, afterSuccess + afterErrors),
    lastErrorAfterInjectionMs
  };
}

async function startOpenMesh(targets) {
  const token = randomBytes(24).toString('hex');
  const control = openmesh().register(controlPlane({ token }));
  const controlAddress = await control.listen({ port: 0 });
  const controlUrl = 'http://127.0.0.1:' + controlAddress.port + '/_mesh';
  const admin = new ControlClient({ url: controlUrl, token });
  for (const target of targets) {
    await admin.register('bench-target', {
      id: target.id,
      url: target.url,
      ttl: 30000
    });
  }

  const app = openmesh({
    service: 'bench-caller',
    mesh: {
      control: { url: controlUrl, token },
      defaults: {
        timeout: 1000,
        retries: 1,
        failureThreshold: 1,
        cooldown: 500,
        maxInflight: 1024,
        maxQueue: 4096,
        selection: 'p2c'
      }
    }
  });
  const service = app.mesh('bench-target');
  await service.request('/payload');

  return {
    name: 'openmesh',
    request: async () => {
      const response = await service.request('/payload');
      if (response.statusCode !== 200) throw new Error('OpenMesh status ' + response.statusCode);
      return response.body;
    },
    async close() {
      await app.close();
      await admin.close();
      await control.close();
    }
  };
}

function envoyConfig(listenerPort, clusterName, endpoints, { retry = false, outlier = false } = {}) {
  const hosts = endpoints.map(({ port }) => `
                        - endpoint:
                            address:
                              socket_address:
                                address: 127.0.0.1
                                port_value: ${port}`).join('\n');

  return `static_resources:
  listeners:
    - name: listener
      address:
        socket_address:
          address: 127.0.0.1
          port_value: ${listenerPort}
      filter_chains:
        - filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: mesh_bench
                codec_type: HTTP1
                route_config:
                  name: route
                  virtual_hosts:
                    - name: service
                      domains: ["*"]
                      routes:
                        - match: { prefix: "/" }
                          route:
                            cluster: ${clusterName}
                            timeout: 1s
${retry ? '                            retry_policy:\n                              retry_on: "5xx,connect-failure,reset"\n                              num_retries: 1\n                              per_try_timeout: 0.4s' : ''}
                http_filters:
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
  clusters:
    - name: ${clusterName}
      connect_timeout: 0.25s
      type: STATIC
      lb_policy: LEAST_REQUEST
      load_assignment:
        cluster_name: ${clusterName}
        endpoints:
          - lb_endpoints:
${hosts}
${outlier ? '      outlier_detection:\n        consecutive_5xx: 1\n        consecutive_gateway_failure: 1\n        interval: 0.1s\n        base_ejection_time: 2s\n        max_ejection_percent: 100' : ''}
`;
}

function docker(...dockerArgs) {
  try {
    return execFileSync('docker', dockerArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const stdout = error?.stdout ? String(error.stdout) : '';
    const stderr = error?.stderr ? String(error.stderr) : '';
    throw new Error('docker ' + dockerArgs.join(' ') + ' failed\n' + stdout + stderr);
  }
}

function validateEnvoyConfig(configPath) {
  docker(
    'run', '--rm',
    '-v', configPath + ':/etc/envoy/envoy.yaml:ro',
    envoyImage,
    '--mode', 'validate',
    '-c', '/etc/envoy/envoy.yaml'
  );
}

async function waitPort(port, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const connected = await new Promise(resolve => {
      const socket = net.connect({ host: '127.0.0.1', port });
      const done = value => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      };
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      socket.setTimeout(250, () => done(false));
    });
    if (connected) return;
    await sleep(100);
  }
  throw new Error('Timed out waiting for Envoy listener on port ' + port);
}

async function waitRoute(port, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await rawHttpRequest(port);
      return;
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  throw new Error('Envoy listener is up but route never became healthy on port ' + port + ': ' + (lastError?.message || 'unknown'));
}

const agents = new Map();
function rawHttpRequest(port) {
  let agent = agents.get(port);
  if (!agent) {
    agent = new http.Agent({ keepAlive: true, maxSockets: 2048 });
    agents.set(port, agent);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/payload',
      method: 'GET',
      agent
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('end', () => {
        if ((res.statusCode || 0) !== 200) {
          reject(new Error('Envoy status ' + res.statusCode));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
      res.once('error', reject);
    });
    req.once('error', reject);
    req.end();
  });
}

async function startEnvoy(targets) {
  try {
    docker('version');
  } catch (error) {
    throw new Error('Docker is required for the Envoy mesh benchmark: ' + error.message);
  }

  const outboundPort = await freePort();
  let inboundPort = await freePort();
  while (inboundPort === outboundPort) inboundPort = await freePort();
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'openmesh-envoy-'));
  const inboundConfig = path.join(temp, 'inbound.yaml');
  const outboundConfig = path.join(temp, 'outbound.yaml');

  await fsp.writeFile(
    inboundConfig,
    envoyConfig(inboundPort, 'backends', targets, { retry: true, outlier: true })
  );
  await fsp.writeFile(
    outboundConfig,
    envoyConfig(outboundPort, 'inbound_proxy', [{ port: inboundPort }])
  );

  validateEnvoyConfig(inboundConfig);
  validateEnvoyConfig(outboundConfig);

  const suffix = process.pid + '-' + Math.random().toString(16).slice(2);
  const inboundName = 'openmesh-bench-envoy-in-' + suffix;
  const outboundName = 'openmesh-bench-envoy-out-' + suffix;

  docker('run', '-d', '--name', inboundName, '--network', 'host',
    '-v', inboundConfig + ':/etc/envoy/envoy.yaml:ro', envoyImage,
    '-c', '/etc/envoy/envoy.yaml', '--log-level', 'error');
  try {
    await waitPort(inboundPort);
    await waitRoute(inboundPort);
    docker('run', '-d', '--name', outboundName, '--network', 'host',
      '-v', outboundConfig + ':/etc/envoy/envoy.yaml:ro', envoyImage,
      '-c', '/etc/envoy/envoy.yaml', '--log-level', 'error');
    await waitPort(outboundPort);
    await waitRoute(outboundPort);
  } catch (error) {
    let diagnostics = '';
    for (const name of [outboundName, inboundName]) {
      try { diagnostics += '\n[' + name + ' state]\n' + docker('inspect', '-f', '{{json .State}}', name); } catch {}
      try { diagnostics += '\n[' + name + ' logs]\n' + docker('logs', name); } catch {}
    }
    for (const name of [outboundName, inboundName]) {
      try { docker('rm', '-f', name); } catch {}
    }
    throw new Error(error.message + diagnostics);
  }

  return {
    name: 'envoy',
    request: () => rawHttpRequest(outboundPort),
    async close() {
      for (const name of [outboundName, inboundName]) {
        try { docker('rm', '-f', name); } catch {}
      }
      agents.get(outboundPort)?.destroy();
      agents.delete(outboundPort);
      await fsp.rm(temp, { recursive: true, force: true });
    }
  };
}

async function runSteady(framework, peerCount) {
  const targets = await startTargets(peerCount);
  let client;
  try {
    client = framework === 'openmesh' ? await startOpenMesh(targets) : await startEnvoy(targets);
    const result = await measure(client.request);
    return result;
  } finally {
    await client?.close();
    await closeTargets(targets);
  }
}

async function runFailure(framework) {
  const targets = await startTargets(10);
  let client;
  try {
    client = framework === 'openmesh' ? await startOpenMesh(targets) : await startEnvoy(targets);
    const doomed = targets.slice(0, 3);
    const result = await measureFailure(client.request, () => closeTargets(doomed));
    return result;
  } finally {
    await client?.close();
    await closeTargets(targets);
  }
}

function summarize(rows, scenario, framework) {
  const selected = rows.filter(row => row.scenario === scenario && row.framework === framework);
  return {
    scenario,
    framework,
    medianRps: median(selected.map(row => row.rps)),
    medianP50Ms: median(selected.map(row => row.p50Ms)),
    medianP99Ms: median(selected.map(row => row.p99Ms)),
    medianErrors: median(selected.map(row => row.errors)),
    ...(scenario === 'failure-30pct'
      ? {
          medianErrorRateAfterInjection: median(selected.map(row => row.errorRateAfterInjection)),
          medianLastErrorAfterInjectionMs: median(selected.map(row => row.lastErrorAfterInjectionMs))
        }
      : {})
  };
}

(async () => {
  docker('pull', envoyImage);
  await fsp.mkdir(path.dirname(output), { recursive: true });

  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    release: os.release(),
    cpu: os.cpus()[0]?.model,
    cpuCount: os.cpus().length,
    envoyImage,
    config: {
      rounds,
      durationMs,
      warmupMs,
      concurrency,
      pathModel: {
        openmesh: 'Node caller -> OpenMesh app.mesh managed pool -> Node target',
        envoy: 'Node caller -> outbound Envoy -> inbound Envoy -> Node target'
      }
    },
    notes: [
      'Same runner, same Node load generator, same raw Node targets.',
      'Envoy is measured as a two-proxy sidecar-style hop.',
      'OpenMesh includes live service discovery state and managed peer selection in-process.',
      'Linkerd2-proxy is not included in numeric results because the official proxy is control-plane coupled and not designed for standalone static configuration.'
    ],
    results: [],
    summary: []
  };

  const scenarios = [
    { name: 'baseline-1-peer', peerCount: 1 },
    { name: 'lb-10-peer', peerCount: 10 }
  ];
  const frameworks = ['openmesh', 'envoy'];

  for (const scenario of scenarios) {
    for (let round = 0; round < rounds; round++) {
      const order = round % 2 ? [...frameworks].reverse() : frameworks;
      for (const framework of order) {
        const result = await runSteady(framework, scenario.peerCount);
        report.results.push({ scenario: scenario.name, framework, round: round + 1, ...result });
        console.log(
          scenario.name,
          'round', round + 1,
          framework,
          result.rps.toFixed(0) + ' req/s',
          'p99 ' + result.p99Ms.toFixed(2) + ' ms',
          'errors ' + result.errors
        );
        await fsp.writeFile(output, JSON.stringify(report, null, 2) + '\n');
      }
    }
  }

  for (let round = 0; round < rounds; round++) {
    const order = round % 2 ? [...frameworks].reverse() : frameworks;
    for (const framework of order) {
      const result = await runFailure(framework);
      report.results.push({ scenario: 'failure-30pct', framework, round: round + 1, ...result });
      console.log(
        'failure-30pct',
        'round', round + 1,
        framework,
        result.rps.toFixed(0) + ' req/s',
        'post-injection errors ' + result.afterErrors,
        'last error +' + result.lastErrorAfterInjectionMs.toFixed(0) + ' ms'
      );
      await fsp.writeFile(output, JSON.stringify(report, null, 2) + '\n');
    }
  }

  for (const scenario of ['baseline-1-peer', 'lb-10-peer', 'failure-30pct']) {
    for (const framework of frameworks) report.summary.push(summarize(report.results, scenario, framework));
  }

  await fsp.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log('Saved mesh benchmark report:', output);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
