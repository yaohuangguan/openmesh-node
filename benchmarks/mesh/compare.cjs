'use strict';

const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const outputFlag = argv.find(arg => arg.startsWith('--output='));
const files = argv.filter(arg => !arg.startsWith('--output='));

if (files.length < 2) {
  throw new Error('Usage: node benchmarks/mesh/compare.cjs <report.json> <report.json> [...] [--output=file]');
}

const reports = files.map(file => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')));
const machine = reports[0].machine;

for (const report of reports.slice(1)) {
  for (const key of ['platform', 'release', 'cpu', 'cpuCount']) {
    if (report.machine?.[key] !== machine?.[key]) {
      throw new Error(
        'Cross-runtime reports must come from the same runner. ' +
        key + ' differs: ' + JSON.stringify(machine?.[key]) +
        ' vs ' + JSON.stringify(report.machine?.[key])
      );
    }
  }

  if (
    report.config?.duration !== reports[0].config?.duration ||
    report.config?.rounds !== reports[0].config?.rounds ||
    report.config?.connections !== reports[0].config?.connections
  ) {
    throw new Error('Cross-runtime reports must use identical duration, rounds and connections');
  }
}

function percent(value) {
  return value == null ? 'n/a' : (value * 100).toFixed(1) + '%';
}

function ms(value) {
  if (value == null) return 'n/a';
  return (value >= 0 ? '+' : '') + Number(value).toFixed(1) + ' ms';
}

function mib(value) {
  return value == null ? 'n/a' : (value / 1024 / 1024).toFixed(1) + ' MiB';
}

function summary(report, scenario) {
  return report.summary.find(row => row.scenario === scenario) || null;
}

const lines = [
  '# Cross-runtime mesh benchmark',
  '',
  'Same runner: ' + machine.platform + ' ' + machine.release + ' · ' +
    machine.cpu + ' · ' + machine.cpuCount + ' logical CPUs',
  '',
  'Config: ' + reports[0].config.rounds + ' rounds × ' +
    reports[0].config.duration + 's measured, ' +
    reports[0].config.connections + ' connections, 1s warmup per path.',
  '',
  '| Runtime | Data plane | Mesh RPS retention | Mesh p99 tax | Policy RPS retention | Policy p99 tax | Warm RSS |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: |'
];

for (const report of reports) {
  lines.push(
    '| ' + report.system.name + ' ' + report.system.version +
    ' | ' + report.system.language +
    ' | ' + percent(report.normalized.meshRpsRetention) +
    ' | ' + ms(report.normalized.meshP99TaxMs) +
    ' | ' + percent(report.normalized.policyRpsRetention) +
    ' | ' + ms(report.normalized.policyP99TaxMs) +
    ' | ' + mib(report.warmRssBytes) + ' |'
  );
}

lines.push('');
lines.push('Absolute values are preserved for diagnosis, not used as the cross-language ranking metric:');
lines.push('');
lines.push('| Runtime | Direct req/s | Mesh req/s | Policy req/s | Direct p99 | Mesh p99 | Policy p99 |');
lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');

for (const report of reports) {
  const direct = summary(report, 'direct');
  const mesh = summary(report, 'mesh');
  const policy = summary(report, 'policy');

  lines.push(
    '| ' + report.system.name + ' ' + report.system.version +
    ' | ' + (direct ? Math.round(direct.medianRps) : 'n/a') +
    ' | ' + (mesh ? Math.round(mesh.medianRps) : 'n/a') +
    ' | ' + (policy ? Math.round(policy.medianRps) : 'n/a') +
    ' | ' + (direct ? direct.medianP99Ms + ' ms' : 'n/a') +
    ' | ' + (mesh ? mesh.medianP99Ms + ' ms' : 'n/a') +
    ' | ' + (policy ? policy.medianP99Ms + ' ms' : 'n/a') + ' |'
  );
}

lines.push('');
lines.push('Interpretation rule: compare normalized mesh/policy cost first. Raw req/s reflects language, protocol and adapter implementation as well as mesh cost.');
lines.push('');
lines.push('This short CI run is regression/development evidence, not a release performance claim.');

const output = lines.join('\n') + '\n';
process.stdout.write(output);

if (outputFlag) {
  fs.writeFileSync(path.resolve(outputFlag.slice('--output='.length)), output);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, output);
}
