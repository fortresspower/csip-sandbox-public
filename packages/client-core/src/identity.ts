import { createHash, X509Certificate } from 'node:crypto';

const DEVICE_NAMESPACE = 'fortress:csip:device-lfdi';
const NUL = Buffer.from([0]);
const LFDI_PATTERN = /^[0-9a-f]{40}$/;

function identityComponent(value: string, name: string): string {
  if (value.length === 0) throw new Error(`${name} identity must not be empty`);
  if (value.includes('\0')) throw new Error(`${name} identity must not contain NUL`);
  return value;
}

export function aggregatorLfdiFromCertificate(certificate: Uint8Array): string {
  const der = new X509Certificate(Buffer.from(certificate)).raw;
  return createHash('sha256').update(der).digest('hex').slice(0, 40);
}

export function isCanonicalLfdi(value: string): boolean {
  return LFDI_PATTERN.test(value);
}

export function certificateExpiresAt(certificate: Uint8Array): Date {
  const parsed = new X509Certificate(Buffer.from(certificate));
  const expiresAt = new Date(parsed.validTo);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error(`certificate has an invalid notAfter value: ${parsed.validTo}`);
  }
  return expiresAt;
}

export function deviceLfdi(
  partnerId: string,
  canonicalSiteId: string,
  algorithmVersion = 'v1',
): string {
  const partner = identityComponent(partnerId, 'partner');
  const site = identityComponent(canonicalSiteId, 'site');
  const version = identityComponent(algorithmVersion, 'algorithm version');
  const digest = createHash('sha256')
    .update(Buffer.from(`${DEVICE_NAMESPACE}:${version}`, 'utf8'))
    .update(NUL)
    .update(Buffer.from(partner, 'utf8'))
    .update(NUL)
    .update(Buffer.from(site, 'utf8'))
    .digest('hex');
  return digest.slice(0, 40);
}
