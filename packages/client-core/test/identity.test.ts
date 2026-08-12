import { createHash, X509Certificate } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  aggregatorLfdiFromCertificate,
  certificateExpiresAt,
  deviceLfdi,
  isCanonicalLfdi,
} from '../src/identity.js';
import { makeTestPki, type TestPki } from './test-certificates.js';

describe('connection identity', () => {
  let pki: TestPki;

  beforeAll(() => { pki = makeTestPki(); });
  afterAll(() => pki.cleanup());

  it('derives the aggregator LFDI from the first 20 bytes of the certificate DER hash', () => {
    const client = pki.root.issue('aggregator', 'client');
    const der = new X509Certificate(client.certificate).raw;
    const expected = createHash('sha256').update(der).digest('hex').slice(0, 40);

    expect(aggregatorLfdiFromCertificate(client.certificate)).toBe(expected);
    expect(aggregatorLfdiFromCertificate(client.certificate)).toMatch(/^[0-9a-f]{40}$/);
    expect(certificateExpiresAt(client.certificate).getTime()).toBeGreaterThan(Date.now());
  });

  it('derives stable partner-scoped device LFDIs from the versioned namespace', () => {
    expect(deviceLfdi('partner-a', 'site-42')).toBe('fbc7bcf06616af0790e18f0be7063bb42cc2137d');
    expect(deviceLfdi('partner-a', 'site-42')).toBe(deviceLfdi('partner-a', 'site-42'));
    expect(deviceLfdi('partner-b', 'site-42')).toBe('3b5998f6c8e0854c93f7379017aed6dd2a7a170d');
    expect(deviceLfdi('partner-a', 'site-42', 'v2')).toBe('6747a10cd8af6625fe4a2cd5489e9bd50d7e4244');
    expect(isCanonicalLfdi(deviceLfdi('partner-a', 'site-42'))).toBe(true);
    expect(isCanonicalLfdi('ABCDEF0123456789ABCDEF0123456789ABCDEF01')).toBe(false);
  });

  it('rejects ambiguous identity components', () => {
    expect(() => deviceLfdi('', 'site-42')).toThrow(/partner/i);
    expect(() => deviceLfdi('partner-a', '')).toThrow(/site/i);
    expect(() => deviceLfdi('partner\0a', 'site-42')).toThrow(/NUL/i);
  });
});
