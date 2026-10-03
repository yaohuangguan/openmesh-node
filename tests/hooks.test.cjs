const test = require('node:test');
const assert = require('node:assert/strict');
const openmesh = require('openmesh-node');
const { bodyParser } = require('openmesh-node/plugins');
const { serve, request } = require('./helpers.cjs');

test('HTTP hooks run in real request lifecycle order', async t => {
  const phases = [];
  const app = openmesh();

  app.addHook('onRequest', ctx => {
    phases.push('onRequest');
    assert.equal(ctx.requestBody, undefined);
  });

  app.addHook('preParsing', ctx => {
    phases.push('preParsing');
    assert.equal(ctx.requestBody, undefined);
  });

  app.use(bodyParser());

  app.setValidatorCompiler(() => value => {
    phases.push('validator');
    return !!value && value.name === 'Sam';
  });

  app.addHook('preValidation', ctx => {
    phases.push('preValidation');
    assert.deepEqual(ctx.requestBody, { name: 'Sam' });
  });

  app.addHook('preHandler', ctx => {
    phases.push('preHandler');
    assert.deepEqual(ctx.requestBody, { name: 'Sam' });
  });

  app.addHook('postHandler', (ctx, value) => {
    phases.push('postHandler');
    assert.deepEqual(value, { hello: 'Sam' });
    assert.equal(ctx.body, undefined);
  });

  app.addHook('preSerialization', (ctx, value) => {
    phases.push('preSerialization');
    assert.deepEqual(value, { hello: 'Sam' });
  });

  app.addHook('preSend', (ctx, value) => {
    phases.push('preSend');
    assert.equal(value, '{"hello":"Sam"}');
    assert.equal(ctx.response.getHeader('content-type'), 'application/json; charset=utf-8');
  });

  app.addHook('onResponse', ctx => {
    phases.push('onResponse');
    assert.equal(ctx.status, 200);
    assert.equal(ctx.res.writableFinished, true);
  });

  app.post('/', { schema: { body: { type: 'user' } } }, ctx => {
    phases.push('handler');
    return { hello: ctx.requestBody.name };
  });

  const url = await serve(t, app);
  const response = await request(url, '/', { method: 'POST', body: { name: 'Sam' } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), { hello: 'Sam' });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(phases, [
    'onRequest',
    'preParsing',
    'preValidation',
    'validator',
    'preHandler',
    'handler',
    'postHandler',
    'preSerialization',
    'preSend',
    'onResponse'
  ]);
});

test('scoped and route hooks are isolated and onError observes failures', async t => {
  const events = [];
  const app = openmesh();

  app.addHook('onError', (error, ctx) => {
    events.push('root-error:' + ctx.path + ':' + error.message);
  });

  app.setErrorHandler((error, ctx) => {
    ctx.status = 500;
    return { handled: error.message };
  });

  app.register(scope => {
    scope.addHook('preHandler', () => events.push('scope-pre'));
    scope.get('/local', {
      hooks: {
        preHandler: () => events.push('route-pre'),
        preSend: (ctx, value) => events.push('route-send:' + value)
      }
    }, () => ({ ok: true }));

    scope.get('/boom', () => {
      throw new Error('boom');
    });
  }, { prefix: '/api' });

  app.get('/outside', () => ({ ok: 'outside' }));

  const url = await serve(t, app);

  assert.deepEqual((await request(url, '/api/local')).json(), { ok: true });
  assert.deepEqual((await request(url, '/outside')).json(), { ok: 'outside' });
  assert.deepEqual((await request(url, '/api/boom')).json(), { handled: 'boom' });

  assert.deepEqual(events, [
    'scope-pre',
    'route-pre',
    'route-send:{"ok":true}',
    'scope-pre',
    'root-error:/api/boom:boom'
  ]);
});
