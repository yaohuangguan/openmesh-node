'use strict';

const http = require('node:http');
const { execFileSync } = require('node:child_process');

const VERSION = process.env.LINKERD_VERSION || '2.20';
const DIRECT_URL = process.env.LINKERD_DIRECT_URL || 'http://127.0.0.1:18080/work';
const MESH_URL = process.env.LINKERD_MESH_URL || 'http://127.0.0.1:18081/work';
const NAMESPACE = process.env.LINKERD_NAMESPACE || 'bench-linkerd';

function get(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => {
        const status = response.statusCode || 500;
        if (status < 200 || status >= 300) {
          reject(new Error('HTTP ' + status + ' from ' + url));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
    request.once('error', reject);
  });
}

async function waitFor(url, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      await get(url);
      return;
    } catch (error) {
      last = error;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Endpoint did not become ready: ' + url + (last ? ': ' + last.message : ''));
}

function kubectl(args) {
  return execFileSync('kubectl', args, { encoding: 'utf8' }).trim();
}

function namespaceWorkingSetBytes(namespace) {
  try {
    const node = kubectl(['get', 'nodes', '-o', 'jsonpath={.items[0].metadata.name}']);
    const summary = JSON.parse(kubectl(['get', '--raw', '/api/v1/nodes/' + node + '/proxy/stats/summary']));
    let total = 0;
    for (const pod of summary.pods || []) {
      if (pod.podRef?.namespace !== namespace) continue;
      for (const container of pod.containers || []) {
        total += Number(container.memory?.workingSetBytes || 0);
      }
    }
    return total || null;
  } catch {
    return null;
  }
}

async function main() {
  await waitFor(DIRECT_URL);
  await waitFor(MESH_URL);

  const ready = {
    system: 'linkerd',
    version: VERSION,
    language: 'rust-sidecar',
    pid: process.pid,
    capabilities: {
      direct: true,
      mesh: true,
      policy: false,
      mtls: true,
      mtlsIncludedInMesh: true,
      failover: true
    },
    endpoints: {
      direct: DIRECT_URL,
      mesh: MESH_URL,
      health: MESH_URL
    },
    topology: {
      backends: 3,
      sidecars: 4,
      kubernetes: '1.35',
      path: 'gateway app -> Linkerd outbound -> Linkerd inbound -> backend app'
    },
    rssBytes: namespaceWorkingSetBytes(NAMESPACE)
  };

  process.send?.(ready);

  let failed = false;

  process.on('message', message => {
    if (message === 'stats') {
      process.send?.({ type: 'stats', rssBytes: namespaceWorkingSetBytes(NAMESPACE) });
      return;
    }

    if (message?.type === 'failover') {
      let target = null;
      if (!failed) {
        failed = true;
        target = kubectl([
          'get', 'pods', '-n', NAMESPACE,
          '-l', 'app=bench-backend',
          '-o', 'jsonpath={.items[0].metadata.name}'
        ]);
        kubectl(['delete', 'pod', target, '-n', NAMESPACE, '--wait=false']);
      }
      process.send?.({ type: 'failover', target });
      return;
    }

    if (message === 'close') {
      process.disconnect?.();
    }
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
  process.disconnect?.();
});
