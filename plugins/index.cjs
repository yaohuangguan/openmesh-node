'use strict';
const { randomUUID, randomBytes } = require('node:crypto');
const { HttpError } = require('../lib/context.cjs');
function jsonBody({ limit = 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('Body limit must be a positive integer');
  return async (ctx, next) => {
    const type = (ctx.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (ctx.req.body !== undefined || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(ctx.method) || !(type === 'application/json' || type.endsWith('+json'))) return next();
    const declared = Number(ctx.get('content-length'));
    if (declared > limit) { ctx.set('connection', 'close'); ctx.req.resume(); throw new HttpError(413, 'Request body too large'); }
    const body = await new Promise((resolve, reject) => {
      const chunks = []; let size = 0, settled = false;
      function clean() { ctx.req.off('data', data); ctx.req.off('end', ended); ctx.req.off('error', failed); ctx.req.off('aborted', aborted); }
      function failed(error) { if (settled) return; settled = true; clean(); reject(error); }
      function aborted() { failed(new HttpError(400, 'Request aborted')); }
      function data(chunk) { size += chunk.length; if (size > limit) { ctx.set('connection', 'close'); failed(new HttpError(413, 'Request body too large')); ctx.req.resume(); } else chunks.push(chunk); }
      function ended() { if (settled) return; settled = true; clean(); resolve(Buffer.concat(chunks, size)); }
      ctx.req.on('data', data); ctx.req.once('end', ended); ctx.req.once('error', failed); ctx.req.once('aborted', aborted);
    });
    try { ctx.req.body = body.length ? JSON.parse(body.toString('utf8')) : undefined; } catch (_) { throw new HttpError(400, 'Invalid JSON body'); }
    return next();
  };
}
function requestContext({ service = 'openmesh', requestIdHeader = 'x-request-id' } = {}) {
  requestIdHeader = requestIdHeader.toLowerCase();
  return async (ctx, next) => {
    const supplied = ctx.get(requestIdHeader);
    const requestId = typeof supplied === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : randomUUID();
    const incoming = ctx.get('traceparent');
    const validTrace = typeof incoming === 'string' && /^00-(?!0{32}-)[\da-f]{32}-(?!0{16}-)[\da-f]{16}-[\da-f]{2}$/.test(incoming);
    const traceId = validTrace ? incoming.slice(3, 35) : randomBytes(16).toString('hex');
    const flags = validTrace ? incoming.slice(-2) : '01';
    const traceparent = `00-${traceId}-${randomBytes(8).toString('hex')}-${flags}`;
    ctx.state.requestId = requestId; ctx.state.service = service; ctx.state.traceparent = traceparent;
    ctx.state.outboundHeaders = { [requestIdHeader]: requestId, traceparent };
    ctx.set(requestIdHeader, requestId); ctx.set('traceparent', traceparent); return next();
  };
}
function health({ ready = () => true, livePath = '/health/live', readyPath = '/health/ready' } = {}) {
  return async app => {
    app.get(livePath, () => ({ status: 'live' }));
    app.get(readyPath, async ctx => { const available = await ready(); ctx.status = available ? 200 : 503; return { status: available ? 'ready' : 'not-ready' }; });
  };
}
module.exports = { jsonBody, requestContext, health };
