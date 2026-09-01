import { X509Certificate } from 'node:crypto';
import { aggregatorLfdiFromCertificate, certificateExpiresAt } from '@fortress-csip/client-core';
import { OperationalError, UsageError } from './errors.js';

/**
 * The identity metadata the toolkit is allowed to show and record.
 *
 * Everything here is derivable by anyone holding the public certificate, which is what makes
 * it safe to print, write into an evidence artifact, and paste into a ticket. The certificate
 * bytes themselves never leave this module.
 */
export interface CertificateIdentity {
  /** Aggregator LFDI: 40 lowercase hex, derived from the DER of the leaf. */
  aggregatorLfdi: string;
  /** SHA-256 of the leaf, 64 lowercase hex, no separators. */
  fingerprintSha256: string;
  notBefore: Date;
  notAfter: Date;
  /** Subject common name, for a human to recognize which certificate this is. */
  subjectCommonName?: string;
}

/**
 * Read identity from certificate bytes.
 *
 * Rejects a private key explicitly rather than letting the X.509 parser fail with a generic
 * message: pointing the toolkit at `client.key` instead of `client.pem` is a common slip, and
 * a partner who does it should be told that, not shown a decoder error.
 */
export function readCertificateIdentity(bytes: Uint8Array): CertificateIdentity {
  const text = Buffer.from(bytes).toString('latin1');
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(text)) {
    throw new UsageError(
      'that file is a private key, not a certificate — pass the certificate (public) file',
    );
  }

  let parsed: X509Certificate;
  try {
    parsed = new X509Certificate(Buffer.from(bytes));
  } catch {
    throw new UsageError('could not parse that file as an X.509 certificate (PEM or DER)');
  }

  const notAfter = certificateExpiresAt(bytes);
  const notBefore = new Date(parsed.validFrom);
  return {
    aggregatorLfdi: aggregatorLfdiFromCertificate(bytes),
    fingerprintSha256: parsed.fingerprint256.replaceAll(':', '').toLowerCase(),
    notBefore: Number.isNaN(notBefore.getTime()) ? new Date(0) : notBefore,
    notAfter,
    subjectCommonName: commonName(parsed.subject),
  };
}

/**
 * Read a certificate from disk.
 *
 * A missing or unreadable file is operational (the environment failed); a file that is not a
 * certificate is usage (the partner pointed at the wrong thing). Keeping those apart is what
 * makes the exit codes worth scripting against.
 */
export async function loadCertificateIdentity(
  path: string,
  readFile: (path: string) => Promise<Uint8Array>,
): Promise<CertificateIdentity> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (error) {
    const code = (error as { code?: string }).code;
    throw new OperationalError(
      `could not read ${path}${code === undefined ? '' : ` (${code})`}`,
      'Check the path and that the file is readable by this user.',
    );
  }
  if (bytes.byteLength === 0) throw new UsageError(`${path} is empty`);
  return readCertificateIdentity(bytes);
}

function commonName(subject: string): string | undefined {
  for (const line of subject.split('\n')) {
    const match = /^CN=(.+)$/.exec(line.trim());
    if (match) return match[1].trim();
  }
  return undefined;
}

/** Days remaining before expiry, negative when already expired. */
export function daysUntil(notAfter: Date, now: Date): number {
  return Math.floor((notAfter.getTime() - now.getTime()) / 86_400_000);
}
