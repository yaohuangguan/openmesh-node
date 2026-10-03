'use strict';

const http = require('node:http');

const port = Number(process.env.PORT || 8080);
const instance = process.env.INSTANCE || 'gateway';
const upstream = process.env.UPSTREAM || '';

const agent = new http.Agent({ keepAlive: true, maxSockets: 4096 });

function upstreamRequest() {
  return new Promise((resolve, reject) => {
    const request = http.get(upstream, { agent }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => {
        const body = Buffer.concat(chunks);
        const status = response.statusCode || 500;
        if (status < 200 || status >= 300) {
          reject(new Error('upstream HTTP ' + status));
          return;
        }
        resolve(body);
      });
    });
    request.once('error', reject);
  });
}

const server = http.createServer(async (request, response) => {
  const route = (request.url || '/').split('?')[0];
  if (route === '/health') {
    response.setHeader('content-type', 'application/json');
    response.end('{"ok":true}');
    return;
  }

  if (route !== '/work') {
    response.statusCode = 404;
    response.end();
    return;
  }

  if (!upstream) {
    const body = JSON.stringify({ ok: true, instance });
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('content-length', Buffer.byteLength(body));
    response.end(body);
    return;
  }

  try {
    const body = await upstreamRequest();
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('content-length', body.length);
    response.end(body);
  } catch (error) {
    response.statusCode = 502;
    response.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(port, '0.0.0.0', () => {
  process.stdout.write('READY ' + port + '\n');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    agent.destroy();
    server.close(() => process.exit(0));
  });
}
