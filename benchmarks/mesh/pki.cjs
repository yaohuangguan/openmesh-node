'use strict';

const { webcrypto } = require('node:crypto');
require('reflect-metadata');
const x509 = require('@peculiar/x509');

x509.cryptoProvider.set(webcrypto);

const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };

function pemPrivateKey(buffer) {
  const base64 = Buffer.from(buffer).toString('base64').match(/.{1,64}/g).join('\n');
  return '-----BEGIN PRIVATE KEY-----\n' + base64 + '\n-----END PRIVATE KEY-----\n';
}

async function createPki(services, trustDomain = 'mesh-bench.test') {
  const caKeys = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );

  const now = Date.now();
  const caCert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=Mesh Benchmark CA',
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 2 * 60 * 60_000),
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

  const workloads = {};
  let serial = 2;

  for (const service of services) {
    const keys = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const identity = 'spiffe://' + trustDomain + '/service/' + service;
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: String(serial++).padStart(2, '0'),
      subject: 'CN=' + service,
      issuer: caCert.subject,
      notBefore: new Date(now - 60_000),
      notAfter: new Date(now + 60 * 60_000),
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
          { type: 'url', value: identity },
          { type: 'dns', value: service + '.mesh-bench.test' }
        ])
      ]
    });

    workloads[service] = {
      identity,
      cert: cert.toString('pem'),
      key: pemPrivateKey(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey))
    };
  }

  return {
    trustDomain,
    ca: caCert.toString('pem'),
    workloads
  };
}

module.exports = { createPki };
