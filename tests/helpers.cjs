const http = require('node:http');
async function serve(t, app) { const address = await app.listen({ port: 0 }); t.after(() => app.close()); return 'http://127.0.0.1:' + address.port; }
function request(base, path = '/', { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    if (body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body)) { body = JSON.stringify(body); headers = { 'content-type': 'application/json', ...headers }; }
    const req = http.request(base + path, { method, headers, agent: false }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.once('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }); }); res.once('error', reject); });
    req.once('error', reject); req.end(body);
  });
}
module.exports = { serve, request };
