'use strict';

const { spawn, execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const autocannon = require('autocannon');

const root = path.resolve(__dirname, '..', '..');

function resolveBinary(envName, commandName) {
  if (process.env[envName]) return process.env[envName];
  try {
    return execFileSync('sh', ['-lc', 'command -v ' + commandName], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(envName + ' is required when ' + commandName + ' is not on PATH');
  }
}

const envoy = resolveBinary('OPENMESH_BENCH_ENVOY', 'envoy');
const daprd = resolveBinary('OPENMESH_BENCH_DAPRD', 'daprd');
const output = path.resolve(__dirname, 'results', 'host-macos.json');

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const index = arg.indexOf('=');
  if (!arg.startsWith('--') || index < 0) throw new Error('Expected --name=value arguments');
  return [arg.slice(2, index), arg.slice(index + 1)];
}));

const duration = Number(args.duration || 5);
const rounds = Number(args.rounds || 3);
const connections = Number(args.connections || 32);
const modes = (args.modes || 'direct,openmesh,envoy,dapr').split(',').filter(Boolean);
const supported = new Set(['direct', 'openmesh', 'envoy', 'dapr']);

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function execAsync(file, argv) {
  return new Promise((resolve, reject) => {
    execFile(file, argv, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode || 500) >= 400) {
          reject(new Error('HTTP ' + res.statusCode + ': ' + text.slice(0, 240)));
          return;
        }
        resolve(text);
      });
    });
    req.setTimeout(2_000, () => req.destroy(new Error('request timeout')));
    req.once('error', reject);
  });
}

async function wait(url, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await get(url);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw lastError || new Error('timeout waiting for ' + url);
}

async function spawnLogged(name, command, argv, options = {}) {
  const logDir = path.join(__dirname, 'results', 'logs');
  await fs.mkdir(logDir, { recursive: true });
  const stdout = require('node:fs').openSync(path.join(logDir, name + '.log'), 'w');
  const child = spawn(command, argv, {
    cwd: root,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', stdout, stdout]
  });
  child.once('exit', code => {
    if (!child.__stopping && code !== 0) {
      process.stderr.write(name + ' exited early with code ' + code + '\n');
    }
  });
  return child;
}

async function stopChildren(children) {
  for (const child of children.reverse()) {
    if (!child || child.exitCode !== null) continue;
    child.__stopping = true;
    child.kill('SIGTERM');
  }
  const deadline = Date.now() + 5_000;
  while (children.some(child => child && child.exitCode === null) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  for (const child of children) {
    if (child && child.exitCode === null) child.kill('SIGKILL');
  }
}

async function psStats(pids) {
  if (!pids.length) return { cpuPercent: 0, rssMiB: 0 };
  const stdout = await execAsync('ps', ['-p', pids.join(','), '-o', '%cpu=,rss=']);
  let cpuPercent = 0;
  let rssKiB = 0;
  for (const line of stdout.trim().split(/\r?\n/)) {
    const [cpu, rss] = line.trim().split(/\s+/);
    cpuPercent += Number(cpu) || 0;
    rssKiB += Number(rss) || 0;
  }
  return { cpuPercent, rssMiB: rssKiB / 1024 };
}

async function load(pids, seconds) {
  const samples = [];
  let active = true;
  const sampler = (async () => {
    while (active) {
      try { samples.push(await psStats(pids)); } catch {}
      await new Promise(resolve => setTimeout(resolve, 400));
    }
  })();

  const result = await new Promise((resolve, reject) => {
    autocannon({
      url: 'http://127.0.0.1:19081/invoke',
      connections,
      pipelining: 1,
      duration: seconds
    }, (error, report) => error ? reject(error) : resolve(report));
  });

  active = false;
  await sampler;

  if (result.errors || result.timeouts || result.non2xx) {
    throw new Error(
      'errors=' + result.errors +
      ' timeouts=' + result.timeouts +
      ' non2xx=' + result.non2xx
    );
  }

  return {
    requestsPerSecond: result.requests.average,
    latencyP50Ms: result.latency.p50,
    latencyP99Ms: result.latency.p99,
    throughputBytesPerSecond: result.throughput.average,
    cpuPercentAvg: samples.length
      ? samples.reduce((sum, row) => sum + row.cpuPercent, 0) / samples.length
      : 0,
    cpuPercentMax: samples.length ? Math.max(...samples.map(row => row.cpuPercent)) : 0,
    rssMiBAvg: samples.length
      ? samples.reduce((sum, row) => sum + row.rssMiB, 0) / samples.length
      : 0,
    rssMiBMax: samples.length ? Math.max(...samples.map(row => row.rssMiB)) : 0
  };
}

async function startMode(mode) {
  const children = [];
  const target = await spawnLogged('target-' + mode, process.execPath, [
    path.join(__dirname, 'target.cjs'),
    '--port=19080'
  ]);
  children.push(target);
  await wait('http://127.0.0.1:19080/healthz');

  let targetUrl = 'http://127.0.0.1:19080';

  if (mode === 'envoy') {
    const inbound = await spawnLogged('envoy-inbound', envoy, [
      '-c', path.join(__dirname, 'envoy-inbound-host.yaml'),
      '--concurrency', '1',
      '--log-level', 'warning'
    ]);
    const outbound = await spawnLogged('envoy-outbound', envoy, [
      '-c', path.join(__dirname, 'envoy-outbound-host.yaml'),
      '--concurrency', '1',
      '--log-level', 'warning'
    ]);
    children.push(inbound, outbound);
    await wait('http://127.0.0.1:19091/data');
    targetUrl = 'http://127.0.0.1:19091';
  }

  if (mode === 'dapr') {
    const targetDapr = await spawnLogged('dapr-target', daprd, [
      '--app-id', 'target',
      '--app-port', '19080',
      '--app-channel-address', '127.0.0.1',
      '--dapr-http-port', '19100',
      '--dapr-grpc-port', '19101',
      '--dapr-internal-grpc-port', '19102',
      '--dapr-internal-grpc-listen-address', '127.0.0.1',
      '--enable-metrics=false',
      '--log-level', 'warn'
    ], { env: { GOMAXPROCS: '1' } });

    const callerDapr = await spawnLogged('dapr-caller', daprd, [
      '--app-id', 'caller',
      '--dapr-http-port', '19200',
      '--dapr-grpc-port', '19201',
      '--dapr-internal-grpc-port', '19202',
      '--dapr-internal-grpc-listen-address', '127.0.0.1',
      '--enable-metrics=false',
      '--log-level', 'warn'
    ], { env: { GOMAXPROCS: '1' } });

    children.push(targetDapr, callerDapr);
    await wait('http://127.0.0.1:19100/v1.0/healthz/outbound');
    await wait('http://127.0.0.1:19200/v1.0/healthz/outbound');
    targetUrl = 'http://127.0.0.1:19200/v1.0/invoke/target/method';
  }

  const caller = await spawnLogged('caller-' + mode, process.execPath, [
    path.join(__dirname, 'caller.cjs'),
    '--mode=' + mode,
    '--port=19081',
    '--target=' + targetUrl
  ]);
  children.push(caller);
  await wait('http://127.0.0.1:19081/healthz');
  await wait('http://127.0.0.1:19081/invoke');

  return children;
}

(async () => {
  for (const mode of modes) {
    if (!supported.has(mode)) throw new Error('Unsupported mode: ' + mode);
  }

  const versions = {
    openmesh: require(path.join(root, 'package.json')).version,
    node: process.version,
    envoy: String(await execAsync(envoy, ['--version'])).trim().split('\n')[0],
    dapr: String(await execAsync(daprd, ['--version'])).trim()
  };

  const report = {
    generatedAt: new Date().toISOString(),
    methodology: 'native macOS processes; identical Node caller/target; end-to-end application-to-application invocation',
    host: {
      platform: process.platform,
      release: os.release(),
      cpu: os.cpus()[0]?.model || null,
      logicalCpuCount: os.cpus().length
    },
    versions,
    config: {
      durationSeconds: duration,
      rounds,
      connections,
      warmupSeconds: 2,
      pipelining: 1,
      envoyWorkers: 1,
      daprGomaxprocs: 1,
      modes
    },
    results: [],
    summary: []
  };

  await fs.mkdir(path.dirname(output), { recursive: true });

  for (const mode of modes) {
    console.log('\n=== ' + mode + ' ===');
    const children = await startMode(mode);
    try {
      const pids = children.map(child => child.pid).filter(Boolean);
      console.log('warmup');
      await load(pids, 2);

      for (let round = 1; round <= rounds; round++) {
        const row = await load(pids, duration);
        row.mode = mode;
        row.round = round;
        report.results.push(row);
        console.log(
          mode + ' round ' + round + ': ' +
          row.requestsPerSecond.toFixed(0) + ' req/s, p99 ' +
          row.latencyP99Ms.toFixed(1) + ' ms, CPU ' +
          row.cpuPercentAvg.toFixed(1) + '%, RSS ' +
          row.rssMiBAvg.toFixed(1) + ' MiB'
        );
        await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
      }
    } finally {
      await stopChildren(children);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  for (const mode of modes) {
    const rows = report.results.filter(row => row.mode === mode);
    report.summary.push({
      mode,
      medianRps: median(rows.map(row => row.requestsPerSecond)),
      medianP50Ms: median(rows.map(row => row.latencyP50Ms)),
      medianP99Ms: median(rows.map(row => row.latencyP99Ms)),
      medianCpuPercent: median(rows.map(row => row.cpuPercentAvg)),
      medianRssMiB: median(rows.map(row => row.rssMiBAvg)),
      maxRssMiB: Math.max(...rows.map(row => row.rssMiBMax))
    });
  }

  const direct = report.summary.find(row => row.mode === 'direct');
  for (const row of report.summary) {
    row.throughputVsDirect = direct ? row.medianRps / direct.medianRps : null;
    row.p99DeltaMs = direct ? row.medianP99Ms - direct.medianP99Ms : null;
    row.rssDeltaMiB = direct ? row.medianRssMiB - direct.medianRssMiB : null;
  }

  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');

  console.log('\n| Path | req/s | vs direct | p50 | p99 | CPU sum | RSS sum |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of report.summary) {
    console.log(
      '| ' + row.mode + ' | ' +
      Math.round(row.medianRps) + ' | ' +
      (row.throughputVsDirect * 100).toFixed(1) + '% | ' +
      row.medianP50Ms.toFixed(1) + ' ms | ' +
      row.medianP99Ms.toFixed(1) + ' ms | ' +
      row.medianCpuPercent.toFixed(1) + '% | ' +
      row.medianRssMiB.toFixed(1) + ' MiB |'
    );
  }

  console.log('\nSaved ' + output);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
