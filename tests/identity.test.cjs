const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');

require('reflect-metadata');
const x509 = require('@peculiar/x509');
x509.cryptoProvider.set(webcrypto);

const openmesh = require('openmesh-node');
const { PeerPool } = require('openmesh-node/mesh');
const {
  controlPlane,
  ControlClient,
  serviceRegistration,
  MeshHttpError
} = require('openmesh-node/services');

const token = 'identity-test-token-123456789';
const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
let pkiPromise;

function pem(tag, value) {
  const base64 = Buffer.from(value).toString('base64');
  const lines = base64.match(/.{1,64}/g) || [];
  return '-----BEGIN ' + tag + '-----\n' + lines.join('\n') + '\n-----END ' + tag + '-----\n';
}

async function createWorkloadCertificate(ca, caKeys, service, serialNumber, notBefore, notAfter) {
  const keys = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );

  const certificate = await x509.X509CertificateGenerator.create({
    serialNumber,
    subject: 'CN=' + service,
    issuer: ca.subject,
    notBefore,
    notAfter,
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
        {
          type: 'url',
          value: 'spiffe://openmesh.test/service/' + service
        }
      ])
    ]
  });

  const privateKey = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  return {
    cert: certificate.toString('pem'),
    key: pem('PRIVATE KEY', privateKey)
  };
}

async function createPki() {
  const caKeys = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const notBefore = new Date(Date.now() - 60_000);
  const notAfter = new Date(Date.now() + 60 * 60 * 1000);

  const caCertificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=OpenMesh Test CA',
    notBefore,
    notAfter,
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

  const [gateway, payments, inventory] = await Promise.all([
    createWorkloadCertificate(caCertificate, caKeys, 'gateway', '02', notBefore, notAfter),
    createWorkloadCertificate(caCertificate, caKeys, 'payments', '03', notBefore, notAfter),
    createWorkloadCertificate(caCertificate, caKeys, 'inventory', '04', notBefore, notAfter)
  ]);

  return {
    ca: caCertificate.toString('pem'),
    gateway,
    payments,
    inventory
  };
}

function pki() {
  return pkiPromise || (pkiPromise = createPki());
}

function identity(material, service, allow) {
  return {
    trustDomain: 'openmesh.test',
    ca: material.ca,
    cert: material[service].cert,
    key: material[service].key,
    ...(allow ? { allow } : {})
  };
}

async function listen(app) {
  const address = await app.listen({ port: 0 });
  return 'https://127.0.0.1:' + address.port;
}

test('workload identity mTLS authenticates both peers and enforces service identity', async () => {
  const material = await pki();
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
    identity: identity(material, 'payments', ['gateway'])
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
    identity: identity(material, 'inventory', ['gateway'])
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
    identity: identity(material, 'gateway'),
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

  const inventory = openmesh({
    service: 'inventory',
    identity: identity(material, 'inventory'),
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
  try {
    paymentsURL = await listen(payments);
    await listen(wrongIdentityServer);

    const authenticated = await gateway.mesh('payments').get('/who');
    assert.deepEqual(authenticated, {
      peerIdentity: 'spiffe://openmesh.test/service/gateway',
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

    const noClientCertificate = new PeerPool({
      peers: [{ id: 'payments-a', url: paymentsURL }],
      retries: 0,
      timeout: 5000,
      tls: {
        ca: material.ca,
        expectedIdentity: 'spiffe://openmesh.test/service/payments'
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
  const material = await pki();

  assert.throws(
    () => openmesh({
      service: 'gateway',
      identity: {
        trustDomain: 'openmesh.test',
        ca: material.ca,
        cert: material.payments.cert,
        key: material.payments.key
      }
    }),
    /configured SPIFFE identity/
  );

  assert.throws(
    () => new PeerPool({
      peers: [{ id: 'plain', url: 'http://127.0.0.1:3000' }],
      tls: {
        ca: material.ca,
        cert: material.gateway.cert,
        key: material.gateway.key,
        expectedIdentity: 'spiffe://openmesh.test/service/payments'
      }
    }),
    /must use HTTPS/
  );

  assert.throws(
    () => openmesh({
      service: 'gateway',
      tls: {
        SNICallback() {}
      },
      identity: identity(material, 'gateway')
    }),
    /SNICallback/
  );

  assert.throws(
    () => new PeerPool({
      tls: {
        ca: material.ca,
        cert: material.gateway.cert,
        key: material.gateway.key,
        expectedIdentity: 'spiffe://openmesh.test/service/payments',
        rejectUnauthorized: false
      }
    }),
    /cannot be false/
  );
});
