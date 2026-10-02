'use strict';
const framework = process.argv[2], scenario = process.argv[3];
const payload = { hello: 'world' };
const route = scenario === 'params' ? '/users/:id' : '/';
let close;
async function readJSON(req) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error('Body limit'); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
(async () => {
  let address;
  if (framework === 'openmesh') {
    const app = require('../index.cjs')();
    if (scenario === 'middleware') app.use(async (ctx, next) => { ctx.set('x-bench', '1'); await next(); });
    if (scenario === 'body') { app.use(require('../plugins/index.cjs').jsonBody()); app.post('/', ctx => ctx.requestBody); }
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
  process.send({ port: address.port, framework, scenario });
  process.on('message', async message => { if (message === 'close') { await close(); process.disconnect(); } });
})().catch(error => { console.error(error); process.exitCode = 1; process.disconnect?.(); });
