'use strict';
const { fork } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const assert = require('node:assert/strict');
const autocannon = require('autocannon');
const options = Object.fromEntries(process.argv.slice(2).map(arg => { const i = arg.indexOf('='); return [arg.slice(2, i), arg.slice(i + 1)]; }));
const duration = Number(options.duration || 3), rounds = Number(options.rounds || 3), connections = Number(options.connections || 32), pipelining = Number(options.pipelining || 1), workers = Number(options.workers || 1);
const frameworks = (options.frameworks || 'openmesh,fastify,koa,express').split(','), scenarios = (options.scenarios || 'plaintext,json,params,body,middleware').split(',');
for (const number of [duration, rounds, connections, pipelining, workers]) if (!Number.isSafeInteger(number) || number < 1) throw new Error('Benchmark numeric options must be positive integers');
const output = path.resolve(__dirname, options.output || 'results/local.json');
const median = values => { const sorted = [...values].sort((a, b) => a - b); const m = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2; };
const run = config => new Promise((resolve, reject) => autocannon(config, (error, result) => error ? reject(error) : resolve(result)));
async function server(framework, scenario) {
  const child = fork(path.join(__dirname, 'server.cjs'), [framework, scenario], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true, env: { ...process.env, ...(options['go-binary'] ? { OPENMESH_GO_BENCH_BINARY: path.resolve(options['go-binary']) } : {}) } });
  let diagnostics = ''; child.stderr.on('data', value => { diagnostics = (diagnostics + value).slice(-5000); });
  const info = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error('Benchmark server startup timeout')); }, 15000); child.once('message', message => { clearTimeout(timer); resolve(message); }); child.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited: ' + code + ' ' + diagnostics)); }); });
  return { info, url: 'http://127.0.0.1:' + info.port, close: () => new Promise(resolve => { const timer = setTimeout(() => child.kill(), 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.send('close'); }) };
}
(async () => {
  const versions = { openmesh: require('../package.json').version, ...Object.fromEntries(['fastify', 'koa', 'express', 'autocannon'].map(name => [name, require(name + '/package.json').version])) };
  const report = { generatedAt: new Date().toISOString(), node: process.version, platform: process.platform, release: os.release(), cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length, versions, config: { duration, rounds, connections, pipelining, workers, warmupSeconds: 1, separateServerProcess: true, frameworks, scenarios }, results: [], summary: [] };
  await fs.mkdir(path.dirname(output), { recursive: true });
  for (const scenario of scenarios) {
    for (let round = 0; round < rounds; round++) {
      const ordered = [...frameworks.slice(round % frameworks.length), ...frameworks.slice(0, round % frameworks.length)];
      for (const framework of ordered) {
        const instance = await server(framework, scenario);
        try {
          const url = instance.url + (scenario === 'params' ? '/users/42' : '/');
          const request = scenario === 'body' ? { method: 'POST', body: '{"value":"payload"}', headers: { 'content-type': 'application/json' } } : {};
          const response = await fetch(url, request); assert.equal(response.status, 200);
          const expected = scenario === 'plaintext' ? 'hello' : scenario === 'params' ? '{"id":"42"}' : scenario === 'body' ? '{"value":"payload"}' : '{"hello":"world"}';
          assert.equal(await response.text(), expected);
          if (scenario === 'middleware') assert.equal(response.headers.get('x-bench'), '1');
          const load = { url, ...request, connections, pipelining, ...(workers > 1 ? { workers } : {}) };
          await run({ ...load, duration: 1 });
          const result = await run({ ...load, duration });
          if (result.errors || result.non2xx || result.timeouts) throw new Error(`${framework}/${scenario}: errors=${result.errors} non2xx=${result.non2xx} timeouts=${result.timeouts}`);
          report.results.push({ framework, scenario, round: round + 1, requestsPerSecond: result.requests.average, latencyMeanMs: result.latency.average, latencyP99Ms: result.latency.p99, errors: result.errors, timeouts: result.timeouts, non2xx: result.non2xx, bytesPerSecond: result.throughput.average, duration: result.duration, ...(instance.info.go ? { go: instance.info.go, gomaxprocs: instance.info.gomaxprocs } : {}) });
          console.log(`${scenario} round ${round + 1}: ${framework} ${result.requests.average.toFixed(0)} req/s, p99 ${result.latency.p99} ms`);
          await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
        } finally { await instance.close(); }
      }
    }
  }
  for (const scenario of scenarios) for (const framework of frameworks) { const rows = report.results.filter(row => row.framework === framework && row.scenario === scenario); report.summary.push({ framework, scenario, medianRps: median(rows.map(x => x.requestsPerSecond)), minRps: Math.min(...rows.map(x => x.requestsPerSecond)), maxRps: Math.max(...rows.map(x => x.requestsPerSecond)), medianP99Ms: median(rows.map(x => x.latencyP99Ms)) }); }
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n'); console.log('Saved benchmark report:', output);
})().catch(error => { console.error(error); process.exitCode = 1; });
