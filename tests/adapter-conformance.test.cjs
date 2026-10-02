const test = require('node:test');
const assert = require('node:assert/strict');
const { ServiceRegistry, ConfigStore } = require('openmesh-node/services');
const {
  runRegistryAdapterConformance,
  runConfigAdapterConformance
} = require('openmesh-node/services/testing');

test('registry adapter conformance validates lease ownership, discovery secrecy and watches', async () => {
  const report = await runRegistryAdapterConformance({
    create: () => new ServiceRegistry({ sweepInterval: 0 })
  });

  assert.equal(report.adapter, 'registry');
  assert.equal(report.supportsSnapshot, true);
  assert.equal(report.supportsSubscribe, true);
  assert.equal(report.durabilityChecked, false);
  assert.ok(report.checks.includes('list-without-lease-secret'));
  assert.ok(report.checks.includes('ownership-conflict'));
  assert.ok(report.checks.includes('subscribe'));
});

test('config adapter conformance validates CAS snapshots and watches', async () => {
  const report = await runConfigAdapterConformance({
    create: () => new ConfigStore()
  });

  assert.equal(report.adapter, 'config');
  assert.equal(report.supportsSubscribe, true);
  assert.equal(report.durabilityChecked, false);
  assert.ok(report.checks.includes('replace-cas'));
  assert.ok(report.checks.includes('stale-write-rejected'));
  assert.ok(report.checks.includes('subscribe'));
});

test('adapter conformance can exercise reopen durability profiles', async () => {
  const registry = new ServiceRegistry({ sweepInterval: 0 });
  const registryReport = await runRegistryAdapterConformance({
    create: () => registry,
    reopen: () => registry
  });
  assert.equal(registryReport.durabilityChecked, true);
  assert.ok(registryReport.checks.includes('durability-reopen'));

  const config = new ConfigStore();
  const configReport = await runConfigAdapterConformance({
    create: () => config,
    reopen: () => config
  });
  assert.equal(configReport.durabilityChecked, true);
  assert.ok(configReport.checks.includes('durability-reopen'));
});
