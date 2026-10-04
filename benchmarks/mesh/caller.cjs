'use strict';

const http = require('node:http');

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const index = arg.indexOf('=');
  return [arg.slice(2, index), arg.slice(index + 1)];
}));

const mode = args.mode || 'direct';
const port = Number(args.port || 8081);
const target = args.target || 'http://target:8080';
const token = 'mesh-benchmark-token-123456789';
const agent = new http.Agent({
  keepAlive: true,
  maxSockets: 4096,
  maxFreeSockets: 256
});

function requestJson(url) {
  const address = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      protocol: address.protocol,
      hostname: address.hostname,
      port: address.port,
      path: address.pathname + address.search,
      method: 'GET',
      agent,
      headers: { accept: 'application/json' }
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        chunks.push(chunk);
        size += chunk.length;
      });
      res.once('end', () => {
        const text = Buffer.concat(chunks, size).toString('utf8');
        if ((res.statusCode || 500) >= 400) {
          reject(new Error('upstream status ' + res.statusCode + ': ' + text.slice(0, 200)));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.once('error', reject);
    req.end();
  });
}

async function createInvoker() {
  if (mode !== 'openmesh') {
    const url = target.endsWith('/data') ? target : target.replace(/\/$/, '') + '/data';
    return {
      invoke: () => requestJson(url),
      close: async () => agent.destroy()
    };
  }

  const openmesh = require('openmesh-node');
  const { controlPlane, ControlClient } = require('openmesh-node/services');

  const control = openmesh().register(controlPlane({ token }));
  const address = await control.listen({ port: 0, host: '127.0.0.1' });
  const controlUrl = 'http://127.0.0.1:' + address.port + '/_mesh';

  const registrar = new ControlClient({
    url: controlUrl,
    token,
    timeout: 2_000
  });

  const registration = await registrar.register('target', {
    id: 'target-1',
    url: target,
    ttl: 60_000,
    metadata: { zone: 'local', version: 'v1' }
  });

  const meshApp = openmesh({
    service: 'benchmark-caller',
    mesh: {
      control: {
        url: controlUrl,
        token,
        timeout: 2_000
      },
      defaults: {
        timeout: 2_000,
        retries: 0,
        maxInflight: 4096,
        maxQueue: 0,
        cooldown: 1_000
      }
    }
  });

  await meshApp.ready();
  const service = meshApp.mesh('target');

  return {
    invoke: () => service.get('/data'),
    close: async () => {
      try { await meshApp.close(); } catch {}
      try { await registration.stop(); } catch {}
      try { await registrar.close(); } catch {}
      try { await control.close(); } catch {}
    }
  };
}

async function waitUntilReady(invoke, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await invoke();
      if (value && value.ok === true) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw lastError || new Error('upstream did not become ready');
}

(async () => {
  const invoker = await createInvoker();
  await waitUntilReady(invoker.invoke);

  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': '2'
      });
      res.end('ok');
      return;
    }

    if (req.url !== '/invoke') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    Promise.resolve(invoker.invoke()).then(value => {
      const body = JSON.stringify(value);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(body))
      });
      res.end(body);
    }, error => {
      const body = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      res.writeHead(502, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(body))
      });
      res.end(body);
    });
  });

  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 10_000;
  server.requestTimeout = 0;

  server.listen(port, '0.0.0.0', () => {
    process.stdout.write(JSON.stringify({ ready: true, mode, port }) + '\n');
  });

  const shutdown = () => {
    server.close(async () => {
      await invoker.close();
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
