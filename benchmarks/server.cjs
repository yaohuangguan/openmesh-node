'use strict';
const framework = process.argv[2], scenario = process.argv[3];
const payload = { hello: 'world' };
const route = scenario === 'params' ? '/users/:id' : '/';
let close;
let nativeInfo = {};
async function goServer(proxy) {
  const { spawn, fork } = require('node:child_process');
  let upstream;
  let upstreamURL;
  if (proxy) {
    upstream = fork(__filename, ['openmesh', scenario], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true });
    upstreamURL = await new Promise((resolve, reject) => { upstream.once('message', info => resolve('http://127.0.0.1:' + info.port)); upstream.once('error', reject); upstream.once('exit', () => reject(new Error('Upstream exited'))); });
  }
  if (!process.env.OPENMESH_GO_BENCH_BINARY) throw new Error('Pass --go-binary=/absolute/path/to/go-bench');
  const child = spawn(process.env.OPENMESH_GO_BENCH_BINARY, [scenario, proxy ? 'proxy' : 'native', ...(proxy ? [upstreamURL] : [])], {
    stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true, env: { ...process.env, GOMAXPROCS: '1' }
  });
  const info = await new Promise((resolve, reject) => {
    let output = ''; child.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) { try { resolve(JSON.parse(output.split('\n')[0])); } catch (error) { reject(error); } } });
    child.once('error', reject); child.once('exit', () => reject(new Error('Go server exited')));
  });
  nativeInfo = { go: info.go, gomaxprocs: info.gomaxprocs };
  close = async () => {
    await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    if (upstream) await new Promise(resolve => { upstream.once('exit', resolve); upstream.send('close'); });
  };
  process.once('exit', () => { child.kill(); upstream?.kill(); });
  return { port: info.port };
}
async function readJSON(req) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error('Body limit'); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
(async () => {
  let address;
  if (framework === 'go' || framework === 'go-proxy') {
    address = await goServer(framework === 'go-proxy');
  } else if (framework === 'node') {
    const server = require('node:http').createServer(async (req, res) => {
      try {
        if (scenario === 'middleware') res.setHeader('x-bench', '1');
        res.setHeader('content-type', scenario === 'plaintext' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8');
        const body = scenario === 'plaintext' ? 'hello' : JSON.stringify(scenario === 'body' ? await readJSON(req) : scenario === 'params' ? { id: decodeURIComponent(req.url.split('/')[2]) } : payload);
        res.end(body);
      } catch (_) { res.statusCode = 400; res.end('Bad input'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); address = server.address();
    close = () => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
  } else if (framework === 'openmesh') {
    const app = require('openmesh-node')();
    if (scenario === 'middleware') app.use(async (ctx, next) => { ctx.set('x-bench', '1'); await next(); });
    if (scenario === 'body') { app.use(require('openmesh-node/plugins').jsonBody()); app.post('/', ctx => ctx.requestBody); }
    else app.get(route, ctx => scenario === 'plaintext' ? 'hello' : scenario === 'params' ? { id: ctx.params.id } : payload);
    address = await app.listen({ port: 0 }); close = () => app.close();
  } else if (framework === 'fastify') {
    const app = require('fastify')({ logger: false });
    if (scenario === 'middleware') app.addHook('preHandler', (req, reply, done) => { reply.header('x-bench', '1'); done(); });
    if (scenario === 'body') app.post('/', req => req.body);
    else app.get(route, req => scenario === 'plaintext' ? 'hello' : scenario === 'params' ? { id: req.params.id } : payload);
    await app.listen({ port: 0, host: '127.0.0.1' }); address = app.server.address(); close = () => app.close();
  } else if (framework === 'express') {
    const app = require('express')(); app.disable('x-powered-by'); app.disable('etag');
    if (scenario === 'middleware') app.use((req, res, next) => { res.setHeader('x-bench', '1'); next(); });
    if (scenario === 'body') { app.use(require('express').json({ limit: 1024 * 1024 })); app.post('/', (req, res) => res.json(req.body)); }
    else app.get(route, (req, res) => scenario === 'plaintext' ? res.type('text/plain').send('hello') : res.json(scenario === 'params' ? { id: req.params.id } : payload));
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); }); address = server.address(); close = () => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
  } else if (framework === 'koa') {
    const app = new (require('koa'))();
    if (scenario === 'middleware') app.use(async (ctx, next) => { ctx.set('x-bench', '1'); await next(); });
    app.use(async ctx => { if (scenario === 'body') ctx.body = await readJSON(ctx.req); else ctx.body = scenario === 'plaintext' ? 'hello' : scenario === 'params' ? { id: decodeURIComponent(ctx.path.split('/')[2]) } : payload; });
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); }); address = server.address(); close = () => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
  } else throw new Error('Unknown framework');
  process.send({ port: address.port, framework, scenario, ...nativeInfo });
  process.on('message', async message => { if (message === 'close') { await close(); process.disconnect(); } });
})().catch(error => { console.error(error); process.exitCode = 1; process.disconnect?.(); });
