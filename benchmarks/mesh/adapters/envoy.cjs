'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { createPki } = require('../pki.cjs');

const IMAGE = process.env.ENVOY_IMAGE || 'envoyproxy/envoy:v1.39-latest';
const VERSION = process.env.ENVOY_VERSION || '1.39';
const BACKENDS = 3;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

function httpJson(agent, url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { agent }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => {
        const status = response.statusCode || 500;
        const body = Buffer.concat(chunks).toString('utf8');
        if (status < 200 || status >= 300) {
          reject(new Error('HTTP ' + status + ' from ' + url + ': ' + body));
          return;
        }
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.once('error', reject);
  });
}

async function waitFor(check, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message + (lastError ? ': ' + lastError.message : ''));
}

function address(port) {
  return '{ socket_address: { address: 127.0.0.1, port_value: ' + port + ' } }';
}

function route(clusterName) {
  return [
    'name: local',
    'virtual_hosts:',
    '- name: service',
    '  domains: ["*"]',
    '  routes:',
    '  - match: { prefix: "/" }',
    '    route: { cluster: ' + clusterName + ', timeout: 3s }'
  ].join('\n');
}

function policyRoute() {
  return [
    'name: policy',
    'virtual_hosts:',
    '- name: service',
    '  domains: ["*"]',
    '  routes:',
    '  - match: { prefix: "/" }',
    '    route:',
    '      timeout: 3s',
    '      weighted_clusters:',
    '        clusters:',
    '        - name: stable',
    '          weight: 90',
    '        - name: canary',
    '          weight: 10'
  ].join('\n');
}

function manager(prefix, routeText) {
  return [
    'name: envoy.filters.network.http_connection_manager',
    'typed_config:',
    '  "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager',
    '  stat_prefix: ' + prefix,
    '  codec_type: AUTO',
    '  route_config:',
    routeText.split('\n').map(line => '    ' + line).join('\n'),
    '  http_filters:',
    '  - name: envoy.filters.http.router',
    '    typed_config:',
    '      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router'
  ].join('\n');
}

function cluster(name, ports, tls) {
  const lines = [
    '- name: ' + name,
    '  connect_timeout: 0.25s',
    '  type: STATIC',
    '  lb_policy: LEAST_REQUEST',
    '  load_assignment:',
    '    cluster_name: ' + name,
    '    endpoints:',
    '    - lb_endpoints:'
  ];
  for (const port of ports) {
    lines.push('      - endpoint:');
    lines.push('          address: ' + address(port));
  }
  lines.push('  outlier_detection:');
  lines.push('    consecutive_5xx: 1');
  lines.push('    interval: 0.1s');
  lines.push('    base_ejection_time: 3s');
  lines.push('    max_ejection_percent: 100');
  lines.push('    split_external_local_origin_errors: true');
  lines.push('    consecutive_local_origin_failure: 1');
  if (tls) {
    lines.push('  transport_socket:');
    lines.push('    name: envoy.transport_sockets.tls');
    lines.push('    typed_config:');
    lines.push('      "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext');
    lines.push('      common_tls_context:');
    lines.push('        tls_certificates:');
    lines.push('        - certificate_chain: { filename: "/bench/gateway.pem" }');
    lines.push('          private_key: { filename: "/bench/gateway-key.pem" }');
    lines.push('        validation_context:');
    lines.push('          trusted_ca: { filename: "/bench/ca.pem" }');
    lines.push('          match_typed_subject_alt_names:');
    lines.push('          - san_type: URI');
    lines.push('            matcher: { exact: "' + tls.expected + '" }');
  }
  return lines.join('\n');
}

function listener(name, port, routeText, downstreamTls) {
  const lines = [
    '- name: ' + name,
    '  address: ' + address(port),
    '  filter_chains:',
    '  -'
  ];
  if (downstreamTls) {
    lines.push('    transport_socket:');
    lines.push('      name: envoy.transport_sockets.tls');
    lines.push('      typed_config:');
    lines.push('        "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext');
    lines.push('        require_client_certificate: true');
    lines.push('        common_tls_context:');
    lines.push('          tls_certificates:');
    lines.push('          - certificate_chain: { filename: "/bench/backend.pem" }');
    lines.push('            private_key: { filename: "/bench/backend-key.pem" }');
    lines.push('          validation_context:');
    lines.push('            trusted_ca: { filename: "/bench/ca.pem" }');
    lines.push('            match_typed_subject_alt_names:');
    lines.push('            - san_type: URI');
    lines.push('              matcher: { exact: "' + downstreamTls.expected + '" }');
  }
  lines.push('    filters:');
  const filter = manager(name, routeText).split('\n');
  lines.push('    - ' + filter[0]);
  for (const line of filter.slice(1)) lines.push('      ' + line);
  return lines.join('\n');
}

function inboundConfig(backendPort, plainPort, tlsPort, expectedClient) {
  return [
    'static_resources:',
    '  listeners:',
    listener('inbound_plain', plainPort, route('backend'), null).split('\n').map(line => '  ' + line).join('\n'),
    listener('inbound_mtls', tlsPort, route('backend'), { expected: expectedClient }).split('\n').map(line => '  ' + line).join('\n'),
    '  clusters:',
    cluster('backend', [backendPort]).split('\n').map(line => '  ' + line).join('\n')
  ].join('\n') + '\n';
}

function outboundConfig(meshPort, policyPort, mtlsPort, plainPorts, tlsPorts, expectedServer) {
  return [
    'static_resources:',
    '  listeners:',
    listener('mesh', meshPort, route('mesh'), null).split('\n').map(line => '  ' + line).join('\n'),
    listener('policy', policyPort, policyRoute(), null).split('\n').map(line => '  ' + line).join('\n'),
    listener('mtls', mtlsPort, route('mesh_mtls'), null).split('\n').map(line => '  ' + line).join('\n'),
    '  clusters:',
    cluster('mesh', plainPorts).split('\n').map(line => '  ' + line).join('\n'),
    cluster('stable', plainPorts.slice(0, 2)).split('\n').map(line => '  ' + line).join('\n'),
    cluster('canary', plainPorts.slice(2)).split('\n').map(line => '  ' + line).join('\n'),
    cluster('mesh_mtls', tlsPorts, { expected: expectedServer }).split('\n').map(line => '  ' + line).join('\n')
  ].join('\n') + '\n';
}

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function startEnvoy(name, benchDir, configName) {
  docker([
    'run', '--rm', '--network', 'host',
    '-v', benchDir + ':/bench:ro', IMAGE,
    '--mode', 'validate', '-c', '/bench/' + configName
  ]);
  docker([
    'run', '--rm', '-d', '--name', name, '--network', 'host',
    '-v', benchDir + ':/bench:ro', IMAGE,
    '-c', '/bench/' + configName, '--log-level', 'error'
  ]);
}

function stopContainer(name) {
  try { docker(['rm', '-f', name]); } catch {}
}

function rssBytes(containers) {
  try {
    const pids = [process.pid];
    for (const name of containers) {
      const pid = Number(docker(['inspect', '-f', '{{.State.Pid}}', name]));
      if (pid > 0) pids.push(pid);
    }
    const output = execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' });
    return output.trim().split(/\s+/).filter(Boolean).reduce((sum, value) => sum + Number(value) * 1024, 0);
  } catch { return null; }
}

async function main() {
  if (process.platform !== 'linux') throw new Error('Envoy adapter requires Linux Docker host networking');
  const pki = await createPki(['envoy-gateway', 'envoy-backend']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmesh-envoy-bench-'));
  fs.writeFileSync(path.join(dir, 'ca.pem'), pki.ca);
  fs.writeFileSync(path.join(dir, 'gateway.pem'), pki.workloads['envoy-gateway'].cert);
  fs.writeFileSync(path.join(dir, 'gateway-key.pem'), pki.workloads['envoy-gateway'].key);
  fs.writeFileSync(path.join(dir, 'backend.pem'), pki.workloads['envoy-backend'].cert);
  fs.writeFileSync(path.join(dir, 'backend-key.pem'), pki.workloads['envoy-backend'].key);
  for (const file of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, file), 0o644);

  const agent = new http.Agent({ keepAlive: true, maxSockets: 4096 });
  const backends = [];
  const plainPorts = [];
  const tlsPorts = [];
  const containers = [];
  const prefix = 'openmesh-meshbench-' + process.pid + '-';
  let gateway;

  try {
    for (let i = 0; i < BACKENDS; i += 1) {
      const instance = 'backend-' + String.fromCharCode(97 + i);
      const server = http.createServer((req, res) => {
        if ((req.url || '/').split('?')[0] !== '/work') { res.statusCode = 404; res.end(); return; }
        const body = JSON.stringify({ ok: true, instance });
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('content-length', Buffer.byteLength(body));
        res.end(body);
      });
      const backendPort = await listen(server);
      backends.push({ instance, server, closed: false });
      const plainPort = await freePort();
      const tlsPort = await freePort();
      plainPorts.push(plainPort);
      tlsPorts.push(tlsPort);
      const configName = 'inbound-' + i + '.yaml';
      fs.writeFileSync(path.join(dir, configName), inboundConfig(
        backendPort, plainPort, tlsPort, pki.workloads['envoy-gateway'].identity
      ));
      const name = prefix + 'inbound-' + i;
      startEnvoy(name, dir, configName);
      containers.push(name);
    }

    const meshPort = await freePort();
    const policyPort = await freePort();
    const mtlsPort = await freePort();
    fs.writeFileSync(path.join(dir, 'outbound.yaml'), outboundConfig(
      meshPort, policyPort, mtlsPort, plainPorts, tlsPorts, pki.workloads['envoy-backend'].identity
    ));
    const outboundName = prefix + 'outbound';
    startEnvoy(outboundName, dir, 'outbound.yaml');
    containers.push(outboundName);

    for (const port of plainPorts.concat(tlsPorts, [meshPort, policyPort, mtlsPort])) {
      await waitFor(() => new Promise(resolve => {
        const socket = net.connect(port, '127.0.0.1');
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => resolve(false));
      }), 'Envoy listener not ready on ' + port);
    }

    const directUrl = 'http://127.0.0.1:' + backends[0].server.address().port + '/work';
    gateway = http.createServer(async (req, res) => {
      const routePath = (req.url || '/').split('?')[0];
      try {
        let value;
        if (routePath === '/health') value = { ok: true };
        else if (routePath === '/direct') value = await httpJson(agent, directUrl);
        else if (routePath === '/mesh') value = await httpJson(agent, 'http://127.0.0.1:' + meshPort + '/work');
        else if (routePath === '/policy') value = await httpJson(agent, 'http://127.0.0.1:' + policyPort + '/work');
        else if (routePath === '/mtls') value = await httpJson(agent, 'http://127.0.0.1:' + mtlsPort + '/work');
        else { res.statusCode = 404; res.end(); return; }
        const body = JSON.stringify(value);
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('content-length', Buffer.byteLength(body));
        res.end(body);
      } catch (error) {
        res.statusCode = 502;
        res.end(JSON.stringify({ error: error.message }));
      }
    });
    const gatewayPort = await listen(gateway);

    await httpJson(agent, 'http://127.0.0.1:' + meshPort + '/work');
    await httpJson(agent, 'http://127.0.0.1:' + policyPort + '/work');
    await httpJson(agent, 'http://127.0.0.1:' + mtlsPort + '/work');

    const base = 'http://127.0.0.1:' + gatewayPort;
    process.send?.({
      system: 'envoy', version: VERSION, language: 'cpp-sidecar', pid: process.pid,
      capabilities: { direct: true, mesh: true, policy: true, mtls: true, mtlsIncludedInMesh: false, failover: true },
      endpoints: { direct: base + '/direct', mesh: base + '/mesh', policy: base + '/policy', mtls: base + '/mtls', health: base + '/health' },
      topology: { backends: BACKENDS, sidecars: BACKENDS + 1, path: 'gateway -> outbound Envoy -> inbound Envoy -> backend' },
      rssBytes: rssBytes(containers)
    });

    let failed = false;
    const close = async () => {
      agent.destroy();
      if (gateway) await new Promise(resolve => gateway.close(resolve));
      for (const item of backends) if (!item.closed) await new Promise(resolve => item.server.close(resolve));
      for (const name of containers.slice().reverse()) stopContainer(name);
      fs.rmSync(dir, { recursive: true, force: true });
    };

    process.on('message', async message => {
      if (message === 'stats') { process.send?.({ type: 'stats', rssBytes: rssBytes(containers) }); return; }
      if (message?.type === 'failover') {
        if (!failed) {
          failed = true;
          const target = backends[0];
          target.closed = true;
          await new Promise(resolve => target.server.close(resolve));
          stopContainer(prefix + 'inbound-0');
          process.send?.({ type: 'failover', target: target.instance });
        } else process.send?.({ type: 'failover', target: backends[0].instance });
        return;
      }
      if (message === 'close') { await close(); process.disconnect?.(); }
    });
    process.once('SIGTERM', async () => { await close(); process.exit(0); });
  } catch (error) {
    for (const name of containers.slice().reverse()) stopContainer(name);
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; process.disconnect?.(); });
