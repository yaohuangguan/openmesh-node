'use strict';

const fs = require('node:fs');
const path = require('node:path');

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new TypeError(label + ' must be a positive number');
  return number;
}

function evaluate(report, options = {}) {
  const minRatio = finite(options.minRatio ?? 0.82, 'minRatio');
  const minGeomean = finite(options.minGeomean ?? 0.88, 'minGeomean');
  const maxP99Ratio = finite(options.maxP99Ratio ?? 3, 'maxP99Ratio');
  if (!report || !Array.isArray(report.summary)) throw new TypeError('Benchmark report must contain summary rows');

  const openmesh = report.summary.filter(row => row.framework === 'openmesh');
  const scenarios = [];
  const failures = [];

  for (const current of openmesh) {
    const baseline = report.summary.find(row => row.framework === 'fastify' && row.scenario === current.scenario);
    if (!baseline) {
      failures.push('Missing Fastify baseline for ' + current.scenario);
      continue;
    }

    const ratio = current.medianRps / baseline.medianRps;
    const p99Ratio = current.medianP99Ms / Math.max(0.1, baseline.medianP99Ms);
    const row = {
      scenario: current.scenario,
      openmeshRps: current.medianRps,
      fastifyRps: baseline.medianRps,
      ratio,
      openmeshP99Ms: current.medianP99Ms,
      fastifyP99Ms: baseline.medianP99Ms,
      p99Ratio
    };
    scenarios.push(row);

    if (ratio < minRatio) {
      failures.push(current.scenario + ': throughput ratio ' + ratio.toFixed(3) + ' < ' + minRatio.toFixed(3));
    }
    if (p99Ratio > maxP99Ratio) {
      failures.push(current.scenario + ': p99 ratio ' + p99Ratio.toFixed(2) + ' > ' + maxP99Ratio.toFixed(2));
    }
  }

  if (!scenarios.length) failures.push('No OpenMesh/Fastify benchmark pairs found');
  const geomeanRatio = scenarios.length
    ? Math.exp(scenarios.reduce((sum, row) => sum + Math.log(row.ratio), 0) / scenarios.length)
    : 0;
  if (scenarios.length && geomeanRatio < minGeomean) {
    failures.push('Geometric mean throughput ratio ' + geomeanRatio.toFixed(3) + ' < ' + minGeomean.toFixed(3));
  }

  return {
    passed: failures.length === 0,
    thresholds: { minRatio, minGeomean, maxP99Ratio },
    geomeanRatio,
    scenarios,
    failures
  };
}

function parseArgs(argv) {
  return Object.fromEntries(argv.map(arg => {
    if (!arg.startsWith('--') || !arg.includes('=')) throw new Error('Expected --name=value arguments');
    const index = arg.indexOf('=');
    return [arg.slice(2, index), arg.slice(index + 1)];
  }));
}

function render(result) {
  const lines = [
    '| Scenario | OpenMesh req/s | Fastify req/s | RPS ratio | p99 ratio |',
    '| --- | ---: | ---: | ---: | ---: |'
  ];
  for (const row of result.scenarios) {
    lines.push(
      '| ' + row.scenario + ' | ' +
      Math.round(row.openmeshRps) + ' | ' +
      Math.round(row.fastifyRps) + ' | ' +
      (row.ratio * 100).toFixed(1) + '% | ' +
      row.p99Ratio.toFixed(2) + 'x |'
    );
  }
  lines.push('');
  lines.push('Geometric mean RPS ratio: ' + (result.geomeanRatio * 100).toFixed(1) + '%');
  if (result.failures.length) {
    lines.push('');
    lines.push('Failures:');
    for (const failure of result.failures) lines.push('- ' + failure);
  }
  return lines.join('\n');
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const reportPath = path.resolve(process.cwd(), args.report || 'benchmarks/results/ci.json');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const result = evaluate(report, {
      minRatio: args['min-ratio'],
      minGeomean: args['min-geomean'],
      maxP99Ratio: args['max-p99-ratio']
    });
    const output = render(result);
    console.log(output);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, output + '\n');
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = { evaluate, render };
