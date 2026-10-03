'use strict';

const { fork } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const autocannon = require('autocannon');

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const index = arg.indexOf('=');
  if (!arg.startsWith('--') || index < 0) throw new Error('Expected --name=value arguments');
  return [arg.slice(2, index), arg.slice(index + 1)];
}));

const duration = Number(args.duration || 3);
const rounds = Number(args.rounds || 3);
const connections = Number(args.connections || 32);
const adapterName = args.adapter || 'openmesh';
const output = path.resolve(__dirname, args.output || 'results/openmesh-local.json');

for (const [name, value] of Object.entries({ duration, rounds, connections })) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(name + ' must be a positive integer');
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function runLoad(options) {
  return new Promise((resolve, reject) => {
    autocannon(options, (error, result) => error ? reject(error) : resolve(result));
  });
}

function startAdapter(name) {
  const file = path.join(__dirname, 'adapters', name + '.cjs');
  const child = fork(file, [], {
    cwd: path.resolve(__dirname, '../..'),
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true
  });

  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-10000); });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Adapter startup timed out: ' + stderr));
    }, 60000);

    child.once('message', info => {
      clearTimeout(timer);
      resolve({
        child,
        info,
        close: () => new Promise(done => {
          const killTimer = setTimeout(() => child.kill(), 5000);
          child.once('exit', () => {
            clearTimeout(killTimer);
            done();
          });
          child.send('close');
        })
      });
    });

    child.once('error', reject);
    child.once('exit', code => {
      clearTimeout(timer);
      if (code && code !== 0) reject(new Error('Adapter exited ' + code + ': ' + stderr));
    });
  });
}

async function requestAdapter(child, request, expectedType, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('message', listener);
      reject(new Error('Adapter message timed out: ' + expectedType));
    }, timeout);
    const listener = message => {
      if (message?.type !== expectedType) return;
      clearTimeout(timer);
      child.off('message', listener);
      resolve(message);
    };
    child.on('message', listener);
    child.send(request);
  });
}

async function readStats(child) {
  try {
    return await requestAdapter(child, 'stats', 'stats', 2000);
  } catch {
    return null;
  }
}

async function measureFailover(adapter) {
  if (!adapter.info.capabilities?.failover || !adapter.info.endpoints.mesh) return null;

  const started = performance.now();
  const trigger = await requestAdapter(adapter.child, { type: 'failover' }, 'failover', 15000);
  let attempts = 0;
  let errors = 0;
  let consecutiveSuccesses = 0;
  let firstSuccessMs = null;
  const deadline = performance.now() + 10000;

  while (performance.now() < deadline && consecutiveSuccesses < 20) {
    attempts += 1;
    try {
      const response = await fetch(adapter.info.endpoints.mesh, {
        headers: { connection: 'close' }
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      await response.arrayBuffer();
      if (firstSuccessMs === null) firstSuccessMs = performance.now() - started;
      consecutiveSuccesses += 1;
    } catch {
      errors += 1;
      consecutiveSuccesses = 0;
    }
  }

  return {
    target: trigger.target || null,
    recoveryMs: consecutiveSuccesses >= 20 ? performance.now() - started : null,
    firstSuccessMs,
    attempts,
    errors,
    errorRate: attempts ? errors / attempts : null,
    stableSuccessWindow: 20
  };
}

(async () => {
  const adapter = await startAdapter(adapterName);
  const report = {
    generatedAt: new Date().toISOString(),
    machine: {
      node: process.version,
      platform: process.platform,
      release: os.release(),
      cpu: os.cpus()[0]?.model || null,
      cpuCount: os.cpus().length
    },
    config: {
      duration,
      rounds,
      connections,
      warmupSeconds: 1,
      adapter: adapterName
    },
    system: {
      name: adapter.info.system,
      version: adapter.info.version,
      language: adapter.info.language,
      topology: adapter.info.topology,
      capabilities: adapter.info.capabilities || null
    },
    startupRssBytes: adapter.info.rssBytes,
    results: [],
    summary: []
  };

  try {
    const scenarios = ['direct', 'mesh', 'policy', 'mtls'];

    for (let round = 0; round < rounds; round += 1) {
      const ordered = [
        ...scenarios.slice(round % scenarios.length),
        ...scenarios.slice(0, round % scenarios.length)
      ];

      for (const scenario of ordered) {
        const url = adapter.info.endpoints[scenario];
        if (!url) continue;

        const load = {
          url,
          connections,
          headers: scenario === 'policy' ? { 'x-bench-key': 'bench-user-' + round } : undefined
        };
        await runLoad({ ...load, duration: 1 });
        const result = await runLoad({ ...load, duration });

        if (result.errors || result.timeouts || result.non2xx) {
          throw new Error(
            scenario + ' round ' + (round + 1) +
            ': errors=' + result.errors +
            ' timeouts=' + result.timeouts +
            ' non2xx=' + result.non2xx
          );
        }

        report.results.push({
          scenario,
          round: round + 1,
          order: ordered.indexOf(scenario) + 1,
          requestsPerSecond: result.requests.average,
          latencyP50Ms: result.latency.p50,
          latencyP99Ms: result.latency.p99,
          bytesPerSecond: result.throughput.average,
          errors: result.errors,
          timeouts: result.timeouts,
          non2xx: result.non2xx
        });

        console.log(
          'round ' + (round + 1) + ' / ' + scenario + ': ' +
          result.requests.average.toFixed(0) + ' req/s, p99 ' +
          result.latency.p99 + ' ms'
        );
      }
    }

    for (const scenario of ['direct', 'mesh', 'policy', 'mtls']) {
      const rows = report.results.filter(row => row.scenario === scenario);
      if (!rows.length) continue;
      report.summary.push({
        scenario,
        medianRps: median(rows.map(row => row.requestsPerSecond)),
        medianP50Ms: median(rows.map(row => row.latencyP50Ms)),
        medianP99Ms: median(rows.map(row => row.latencyP99Ms))
      });
    }

    const direct = report.summary.find(row => row.scenario === 'direct');
    const mesh = report.summary.find(row => row.scenario === 'mesh');
    const policy = report.summary.find(row => row.scenario === 'policy');
    const mtls = report.summary.find(row => row.scenario === 'mtls');

    report.normalized = {
      meshRpsRetention: direct && mesh ? mesh.medianRps / direct.medianRps : null,
      meshP99TaxMs: direct && mesh ? mesh.medianP99Ms - direct.medianP99Ms : null,
      policyRpsRetention: mesh && policy ? policy.medianRps / mesh.medianRps : null,
      policyP99TaxMs: mesh && policy ? policy.medianP99Ms - mesh.medianP99Ms : null,
      mtlsRpsRetention: mesh && mtls ? mtls.medianRps / mesh.medianRps : null,
      mtlsP99TaxMs: mesh && mtls ? mtls.medianP99Ms - mesh.medianP99Ms : null
    };

    const stats = await readStats(adapter.child);
    report.warmRssBytes = stats?.rssBytes ?? null;
    report.failover = await measureFailover(adapter);

    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');

    console.log('');
    console.log('Mesh RPS retention:', report.normalized.meshRpsRetention === null
      ? 'n/a'
      : (report.normalized.meshRpsRetention * 100).toFixed(1) + '%');
    console.log('Policy RPS retention:', report.normalized.policyRpsRetention === null
      ? 'n/a'
      : (report.normalized.policyRpsRetention * 100).toFixed(1) + '%');
    console.log('mTLS RPS retention:', report.normalized.mtlsRpsRetention === null
      ? (adapter.info.capabilities?.mtlsIncludedInMesh ? 'included in mesh path' : 'n/a')
      : (report.normalized.mtlsRpsRetention * 100).toFixed(1) + '%');
    console.log('Failover recovery:', report.failover?.recoveryMs == null
      ? 'n/a'
      : report.failover.recoveryMs.toFixed(1) + ' ms');
    console.log('Saved:', output);
  } finally {
    await adapter.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
