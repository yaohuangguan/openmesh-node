const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');

require('reflect-metadata');
const x509 = require('@peculiar/x509');
const openmesh = require('openmesh-node');
const { PeerPool } = require('openmesh-node/mesh');
const {
  controlPlane,
  ControlClient,
  serviceRegistration,
  MeshHttpError
} = require('openmesh-node/services');

x509.cryptoProvider.set(webcrypto);

const token = 'identity-test-token-123456789';
const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };

function pemPrivateKey(buffer) {
  const base64 = Buffer.from(buffer).toString('base64').match(/.{1,64}/g).join('\n');
  return '-----BEGIN PRIVATE KEY-----\n' + base64 + '\n-----END PRIVATE KEY-----\n';
}

async function createTestPki() {
  const caKeys = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );

  const now = Date.now();
  const caCert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=OpenMesh Test CA',
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 60 * 60_000),
    signingAlgorithm: algorithm,
    keys: caKeys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 1, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true
      )
    ]
  });

  async function workload(service, serial) {
    const keys = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const identity = 'spiffe://openmesh.test/service/' + service;
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: serial,
      subject: 'CN=' + service,
      issuer: caCert.subject,
      notBefore: new Date(now - 60_000),
      notAfter: new Date(now + 30 * 60_000),
      publicKey: keys.publicKey,
      signingKey: caKeys.privateKey,
      signingAlgorithm: algorithm,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension([
          '1.3.6.1.5.5.7.3.1',
          '1.3.6.1.5.5.7.3.2'
        ]),
        new x509.SubjectAlternativeNameExtension([
          { type: 'url', value: identity }
        ])
      ]
    });

    return {
      identity,
      cert: cert.toString('pem'),
      key: pemPrivateKey(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey))
    };
  }

  return {
    ca: caCert.toString('pem'),
    gateway: await workload('gateway', '02'),
    gatewayNext: await workload('gateway', '05'),
    payments: await workload('payments', '03'),
    inventory: await workload('inventory', '04')
  };
}

const pkiPromise = createTestPki();

function identity(pki, service, allow) {
  return {
    trustDomain: 'openmesh.test',
    ca: pki.ca,
    cert: pki[service].cert,
    key: pki[service].key,
    ...(allow ? { allow } : {})
  };
}

async function listen(app) {
  const address = await app.listen({ port: 0 });
  return 'https://127.0.0.1:' + address.port;
}

test('workload identity mTLS authenticates both peers and enforces service identity', async () => {
  const pki = await pkiPromise;
  const controlApp = openmesh().register(controlPlane({ token }));
  const controlAddress = await controlApp.listen({ port: 0 });
  const controlURL = 'http://127.0.0.1:' + controlAddress.port;
  const registrationClient = new ControlClient({
    url: controlURL + '/_mesh',
    token,
    timeout: 5000
  });

  const payments = openmesh({
    service: 'payments',
    identity: identity(pki, 'payments', ['gateway'])
  })
    .register(serviceRegistration({
      client: registrationClient,
      service: 'payments',
      id: 'payments-a',
      ttl: 5000,
      metadata: { version: 'v1', region: 'nz' },
      url: address => 'https://127.0.0.1:' + address.port
    }))
    .get('/who', ctx => ({
      peerIdentity: ctx.state.peerIdentity,
      peerService: ctx.state.peerService
    }));

  const wrongIdentityServer = openmesh({
    service: 'inventory',
    identity: identity(pki, 'inventory', ['gateway'])
  })
    .register(serviceRegistration({
      client: registrationClient,
      service: 'payments-shadow',
      id: 'payments-shadow-a',
      ttl: 5000,
      url: address => 'https://127.0.0.1:' + address.port
    }))
    .get('/who', () => ({ ok: true }));

  const gateway = openmesh({
    service: 'gateway',
    identity: identity(pki, 'gateway'),
    mesh: {
      control: {
        url: controlURL + '/_mesh',
        token,
        timeout: 5000
      },
      defaults: {
        timeout: 5000,
        retries: 0
      }
    }
  }).get('/self', ctx => ({
    peerIdentity: ctx.state.peerIdentity,
    peerService: ctx.state.peerService
  }));

  const inventory = openmesh({
    service: 'inventory',
    identity: identity(pki, 'inventory'),
    mesh: {
      control: {
        url: controlURL + '/_mesh',
        token,
        timeout: 5000
      },
      defaults: {
        timeout: 5000,
        retries: 0
      }
    }
  });

  let paymentsURL;
  let gatewayURL;
  try {
    paymentsURL = await listen(payments);
    await listen(wrongIdentityServer);
    gatewayURL = await listen(gateway);

    assert.equal(gateway.workload.id, pki.gateway.identity);

    const authenticated = await gateway.mesh('payments').get('/who');
    assert.deepEqual(authenticated, {
      peerIdentity: pki.gateway.identity,
      peerService: 'gateway'
    });

    await assert.rejects(
      inventory.mesh('payments').get('/who'),
      error => {
        assert.ok(error instanceof MeshHttpError);
        assert.equal(error.statusCode, 403);
        return true;
      }
    );

    await assert.rejects(
      gateway.mesh('payments-shadow').get('/who'),
      error => error && error.code === 'IDENTITY_MISMATCH'
    );

    const directGateway = new PeerPool({
      peers: [{ id: 'gateway-a', url: gatewayURL }],
      retries: 0,
      timeout: 5000,
      tls: {
        ca: pki.ca,
        cert: pki.payments.cert,
        key: pki.payments.key,
        expectedIdentity: pki.gateway.identity
      }
    });

    try {
      const beforeRotation = await directGateway.json('/self');
      assert.deepEqual(beforeRotation, {
        peerIdentity: pki.payments.identity,
        peerService: 'payments'
      });
    } finally {
      directGateway.close();
    }

    await gateway.workload.rotate({
      ca: pki.ca,
      cert: pki.gatewayNext.cert,
      key: pki.gatewayNext.key
    }, { graceMs: 0 });

    const afterOutboundRotation = await gateway.mesh('payments').get('/who');
    assert.deepEqual(afterOutboundRotation, {
      peerIdentity: pki.gateway.identity,
      peerService: 'gateway'
    });

    const rotatedGateway = new PeerPool({
      peers: [{ id: 'gateway-a', url: gatewayURL }],
      retries: 0,
      timeout: 5000,
      tls: {
        ca: pki.ca,
        cert: pki.payments.cert,
        key: pki.payments.key,
        expectedIdentity: pki.gateway.identity
      }
    });

    try {
      const afterRotation = await rotatedGateway.json('/self');
      assert.deepEqual(afterRotation, {
        peerIdentity: pki.payments.identity,
        peerService: 'payments'
      });
    } finally {
      rotatedGateway.close();
    }

    await assert.rejects(
      gateway.workload.rotate({
        ca: pki.ca,
        cert: pki.inventory.cert,
        key: pki.inventory.key
      }, { graceMs: 0 }),
      /configured SPIFFE identity/
    );

    const afterRejectedRotation = await gateway.mesh('payments').get('/who');
    assert.equal(afterRejectedRotation.peerService, 'gateway');

    const noClientCertificate = new PeerPool({
      peers: [{ id: 'payments-a', url: paymentsURL }],
      retries: 0,
      timeout: 5000,
      tls: {
        ca: pki.ca,
        expectedIdentity: pki.payments.identity
      }
    });

    try {
      await assert.rejects(noClientCertificate.request('/who'));
    } finally {
      noClientCertificate.close();
    }
  } finally {
    await inventory.close().catch(() => {});
    await gateway.close().catch(() => {});
    await wrongIdentityServer.close().catch(() => {});
    await payments.close().catch(() => {});
    await registrationClient.close().catch(() => {});
    await controlApp.close().catch(() => {});
  }
});

test('workload identity configuration fails closed before serving traffic', async () => {
  const pki = await pkiPromise;

  assert.throws(
    () => openmesh({
      service: 'gateway',
      identity: {
        trustDomain: 'openmesh.test',
        ca: pki.ca,
        cert: pki.payments.cert,
        key: pki.payments.key
      }
    }),
    /configured SPIFFE identity/
  );

  assert.throws(
    () => new PeerPool({
      peers: [{ id: 'plain', url: 'http://127.0.0.1:3000' }],
      tls: {
        ca: pki.ca,
        cert: pki.gateway.cert,
        key: pki.gateway.key,
        expectedIdentity: pki.payments.identity
      }
    }),
    /must use HTTPS/
  );

  assert.throws(
    () => new PeerPool({
      tls: {
        ca: pki.ca,
        cert: pki.gateway.cert,
        key: pki.gateway.key,
        expectedIdentity: pki.payments.identity,
        rejectUnauthorized: false
      }
    }),
    /cannot be false/
  );
});
