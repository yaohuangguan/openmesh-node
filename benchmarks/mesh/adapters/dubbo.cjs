'use strict';

const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');

const CLASSPATH = process.env.DUBBO_CLASSPATH;
const ZOOKEEPER = process.env.DUBBO_ZOOKEEPER || '127.0.0.1:2181';
const JAVA = process.env.JAVA_BIN || 'java';
const VERSION = process.env.DUBBO_VERSION || '3.3.6';
const BACKENDS = 3;

if (!CLASSPATH) {
  throw new Error('DUBBO_CLASSPATH is required');
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function javaProcess(mainClass, args) {
  const child = spawn(JAVA, [
    '-Dorg.slf4j.simpleLogger.defaultLogLevel=error',
    '-Ddubbo.application.logger=slf4j',
    '-cp', CLASSPATH,
    mainClass,
    ...args.map(String)
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  let diagnosticsHead = '';
  let diagnosticsTail = '';
  child.stderr.on('data', chunk => {
    const text = chunk.toString();
    if (diagnosticsHead.length < 20000) {
      diagnosticsHead = (diagnosticsHead + text).slice(0, 20000);
    }
    diagnosticsTail = (diagnosticsTail + text).slice(-30000);
  });
  child.diagnostics = () => {
    if (!diagnosticsTail) return diagnosticsHead;
    if (diagnosticsHead === diagnosticsTail) return diagnosticsHead;
    return diagnosticsHead + '\n--- stderr tail ---\n' + diagnosticsTail;
  };
  return child;
}

function waitReady(child, matcher, timeout = 30000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Java process startup timed out: ' + child.diagnostics()));
    }, timeout);

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
    };

    const onData = chunk => {
      output += chunk.toString();
      const lines = output.split(/\r?\n/);
      output = lines.pop() || '';
      for (const line of lines) {
        const match = matcher(line.trim());
        if (match) {
          cleanup();
          resolve(match);
          return;
        }
      }
    };

    const onExit = code => {
      cleanup();
      reject(new Error('Java process exited before ready (' + code + '): ' + child.diagnostics()));
    };

    const onError = error => {
      cleanup();
      reject(error);
    };

    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function rssBytes(pids) {
  try {
    const output = execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' });
    return output.trim().split(/\s+/).filter(Boolean)
      .reduce((sum, value) => sum + Number(value) * 1024, 0);
  } catch {
    return null;
  }
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 5000))
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function main() {
  const children = [];
  const providerPorts = [];

  try {
    for (let index = 0; index < BACKENDS; index += 1) {
      const port = await freePort();
      const instance = 'backend-' + String.fromCharCode(97 + index);
      const provider = javaProcess(
        'bench.openmesh.dubbo.ProviderMain',
        [instance, port, ZOOKEEPER]
      );
      children.push(provider);
      await waitReady(provider, line => line === 'READY ' + instance + ' ' + port ? { port } : null);
      providerPorts.push(port);
    }

    const httpPort = await freePort();
    const gateway = javaProcess(
      'bench.openmesh.dubbo.GatewayMain',
      [providerPorts[0], ZOOKEEPER, httpPort]
    );
    children.push(gateway);
    await waitReady(gateway, line => {
      const match = /^READY\s+(\d+)$/.exec(line);
      return match ? { port: Number(match[1]) } : null;
    }, 45000);

    const base = 'http://127.0.0.1:' + httpPort;
    const pids = [process.pid, ...children.map(child => child.pid).filter(Boolean)];

    const ready = {
      system: 'dubbo',
      version: VERSION,
      language: 'java-proxyless',
      pid: process.pid,
      capabilities: {
        direct: true,
        mesh: true,
        policy: false,
        mtlsInThisAdapter: false
      },
      endpoints: {
        direct: base + '/direct',
        mesh: base + '/mesh',
        health: base + '/health'
      },
      topology: {
        backends: BACKENDS,
        providerJvms: BACKENDS,
        gatewayJvms: 1,
        registry: 'zookeeper'
      },
      rssBytes: rssBytes(pids)
    };

    if (process.send) process.send(ready);
    else process.stdout.write(JSON.stringify(ready) + '\n');

    process.on('message', async message => {
      if (message === 'stats' && process.send) {
        process.send({ type: 'stats', rssBytes: rssBytes(pids) });
        return;
      }
      if (message === 'close') {
        for (const child of [...children].reverse()) await stop(child);
        process.disconnect?.();
      }
    });

    process.once('SIGTERM', async () => {
      for (const child of [...children].reverse()) await stop(child);
      process.exit(0);
    });
  } catch (error) {
    for (const child of [...children].reverse()) await stop(child);
    throw error;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
  process.disconnect?.();
});
