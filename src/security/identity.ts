import { X509Certificate } from 'node:crypto';

const TRUST_DOMAIN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validateTrustDomain(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !TRUST_DOMAIN.test(value) || value.includes('..')) {
    throw new TypeError('trustDomain must be a valid SPIFFE trust domain');
  }
}

export function validateWorkloadService(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !SERVICE_NAME.test(value)) {
    throw new TypeError('workload service must be a valid OpenMesh service name');
  }
}

export function workloadIdentityUri(trustDomain: string, service: string): string {
  validateTrustDomain(trustDomain);
  validateWorkloadService(service);
  return 'spiffe://' + trustDomain.toLowerCase() + '/service/' + service;
}

export function validateWorkloadIdentity(identity: unknown, label = 'workload identity'): asserts identity is string {
  if (typeof identity !== 'string') throw new TypeError(label + ' must be a SPIFFE URI');
  let parsed: URL;
  try { parsed = new URL(identity); } catch { throw new TypeError(label + ' must be a SPIFFE URI'); }
  if (
    parsed.protocol !== 'spiffe:' ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    !parsed.pathname ||
    parsed.pathname === '/'
  ) {
    throw new TypeError(label + ' must be a SPIFFE URI with a workload path');
  }
}

export function certificateUriIdentities(certificate: { subjectaltname?: string }): string[] {
  const san = certificate.subjectaltname || '';
  return san
    .split(/,\s*/)
    .filter(entry => entry.startsWith('URI:'))
    .map(entry => entry.slice(4));
}

export function certificateHasIdentity(
  certificate: { subjectaltname?: string },
  expectedIdentity: string
): boolean {
  validateWorkloadIdentity(expectedIdentity, 'expected workload identity');
  return certificateUriIdentities(certificate).includes(expectedIdentity);
}

export function certificateHasExclusiveWorkloadIdentity(
  certificate: { subjectaltname?: string },
  expectedIdentity: string
): boolean {
  validateWorkloadIdentity(expectedIdentity, 'expected workload identity');
  const workloadIdentities = certificateUriIdentities(certificate)
    .filter(identity => identity.startsWith('spiffe://'));
  return workloadIdentities.length === 1 && workloadIdentities[0] === expectedIdentity;
}

export function certificatePemHasIdentity(
  certificate: string | Buffer,
  expectedIdentity: string
): boolean {
  const parsed = new X509Certificate(certificate);
  return certificateHasExclusiveWorkloadIdentity(
    { subjectaltname: parsed.subjectAltName },
    expectedIdentity
  );
}

export function workloadServiceFromIdentity(identity: string, trustDomain: string): string | null {
  validateWorkloadIdentity(identity);
  validateTrustDomain(trustDomain);
  const parsed = new URL(identity);
  if (parsed.hostname.toLowerCase() !== trustDomain.toLowerCase()) return null;
  const match = /^\/service\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(parsed.pathname);
  return match ? match[1]! : null;
}
