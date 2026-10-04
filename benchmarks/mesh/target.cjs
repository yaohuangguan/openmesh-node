'use strict';

const http = require('node:http');

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const index = arg.indexOf('=');
  return [arg.slice(2, index), arg.slice(index + 1)];
}));

const port = Number(args.port || 8080);
const payload = JSON.stringify({
  ok: true,
  service: 'target',
  message: 'openmesh-mesh-benchmark',
  data: 'x'.repeat(192)
});

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': '2'
    });
    res.end('ok');
    return;
  }

  if (req.url === '/data') {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(payload))
    });
    res.end(payload);
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.keepAliveTimeout = 5_000;
server.headersTimeout = 10_000;
server.requestTimeout = 0;

server.listen(port, '0.0.0.0', () => {
  process.stdout.write(JSON.stringify({ ready: true, port }) + '\n');
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
