'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../benchmarks/guard.cjs');

function report(openmesh, fastify) {
  return {
    summary: Object.entries(openmesh).flatMap(([scenario, values]) => [
      { framework: 'openmesh', scenario, medianRps: values.rps, medianP99Ms: values.p99 },
      { framework: 'fastify', scenario, medianRps: fastify[scenario].rps, medianP99Ms: fastify[scenario].p99 }
    ])
  };
}

test('benchmark guard uses normalized throughput and latency ratios', () => {
  const result = evaluate(report(
    { plaintext: { rps: 950, p99: 2 }, json: { rps: 900, p99: 3 } },
    { plaintext: { rps: 1000, p99: 2 }, json: { rps: 1000, p99: 2 } }
  ), { minRatio: 0.82, minGeomean: 0.88, maxP99Ratio: 2 });

  assert.equal(result.passed, true);
  assert.ok(result.geomeanRatio > 0.92);
});

test('benchmark guard rejects material normalized regressions', () => {
  const result = evaluate(report(
    { plaintext: { rps: 700, p99: 8 } },
    { plaintext: { rps: 1000, p99: 2 } }
  ), { minRatio: 0.82, minGeomean: 0.88, maxP99Ratio: 3 });

  assert.equal(result.passed, false);
  assert.ok(result.failures.some(failure => failure.includes('throughput ratio')));
  assert.ok(result.failures.some(failure => failure.includes('p99 ratio')));
});
