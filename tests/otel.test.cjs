const test = require('node:test');
const assert = require('node:assert/strict');
const { createOpenTelemetryObservers } = require('openmesh-node/otel');

function fakeMeter() {
  const records = [];
  return {
    records,
    createCounter(name, options) {
      records.push({ kind: 'counter.created', name, options });
      return {
        add(value, attributes) {
          records.push({ kind: 'counter.add', name, value, attributes });
        }
      };
    },
    createHistogram(name, options) {
      records.push({ kind: 'histogram.created', name, options });
      return {
        record(value, attributes) {
          records.push({ kind: 'histogram.record', name, value, attributes });
        }
      };
    }
  };
}

test('OpenTelemetry bridge maps app and peer lifecycle events into bounded metrics', () => {
  const meter = fakeMeter();
  const observers = createOpenTelemetryObservers({
    meter,
    attributes: { service: 'users', region: 'test' }
  });

  observers.onAppEvent({
    type: 'request.start',
    at: Date.now(),
    method: 'GET',
    path: '/users/42?secret=no',
    route: '/users/:id'
  });
  observers.onAppEvent({
    type: 'request.finish',
    at: Date.now(),
    method: 'GET',
    path: '/users/42?secret=no',
    route: '/users/:id',
    statusCode: 200,
    durationMs: 250,
    aborted: false
  });
  observers.onAppEvent({
    type: 'request.error',
    at: Date.now(),
    method: 'GET',
    path: '/users/42?secret=no',
    route: '/users/:id',
    code: 'TEST_ERROR',
    statusCode: 500
  });
  observers.onPeerEvent({
    type: 'peer.success',
    at: Date.now(),
    peer: { id: 'users-a', url: 'https://private.example.internal' },
    method: 'GET',
    path: '/private/path',
    attempt: 1,
    statusCode: 200,
    latencyMs: 50
  });
  observers.onPeerEvent({
    type: 'admission.rejected',
    at: Date.now(),
    inflight: 64,
    queued: 128
  });
  observers.onPeerEvent({
    type: 'concurrency.changed',
    at: Date.now(),
    previous: 16,
    current: 12,
    reason: 'latency',
    observedLatencyMs: 200
  });

  const requestDuration = meter.records.find(record =>
    record.kind === 'histogram.record' && record.name === 'openmesh.server.request.duration'
  );
  assert.equal(requestDuration.value, 0.25);
  assert.equal(requestDuration.attributes['http.route'], '/users/:id');
  assert.equal(requestDuration.attributes['http.response.status_code'], 200);
  assert.equal(requestDuration.attributes.service, 'users');
  assert.equal('path' in requestDuration.attributes, false);

  const peerDuration = meter.records.find(record =>
    record.kind === 'histogram.record' && record.name === 'openmesh.peer.request.duration'
  );
  assert.equal(peerDuration.value, 0.05);
  assert.equal(peerDuration.attributes['openmesh.peer.id'], 'users-a');
  assert.equal(Object.values(peerDuration.attributes).includes('https://private.example.internal'), false);
  assert.equal(Object.values(peerDuration.attributes).includes('/private/path'), false);

  assert.ok(meter.records.some(record =>
    record.kind === 'counter.add' && record.name === 'openmesh.peer.admission.rejected' && record.value === 1
  ));
  assert.ok(meter.records.some(record =>
    record.kind === 'histogram.record' && record.name === 'openmesh.peer.concurrency.limit' && record.value === 12
  ));
});

test('OpenTelemetry bridge validates its injected meter and static attributes', () => {
  assert.throws(() => createOpenTelemetryObservers({ meter: {} }), /createCounter/);
  assert.throws(() => createOpenTelemetryObservers({
    meter: fakeMeter(),
    attributes: []
  }), /attributes/);
});
