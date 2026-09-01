import { execFile as execFileCallback } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { OperationalError } from '../errors.js';

/**
 * Disposable certificate authority for the loopback mTLS rehearsal.
 *
 * The logic here mirrors `packages/client-core/test/test-certificates.ts`, but this is a
 * separate production module rather than an import of it: a shipped command must not depend
 * on a test directory, which is excluded from the build and free to change shape whenever a
 * test needs it to.
 *
 * Everything it creates is deliberately short-lived and conspicuously named. The material is
 * written to a mode-0700 directory with mode-0600 keys, and removed on success, on failure,
 * and on a signal — a rehearsal that leaves private keys in the temp directory is worse than
 * no rehearsal.
 */

const execFile = promisify(execFileCallback);

/** Long enough for a rehearsal that a laptop suspend cannot invalidate; short enough to be inert. */
const VALIDITY_DAYS = 1;

export interface IssuedCertificate {
  certificate: Buffer;
  privateKey: Buffer;
  /** Path of the certificate on disk, for handing to a TLS server. */
  certificatePath: string;
  privateKeyPath: string;
}

export interface TestAuthority {
  name: string;
  certificate: Buffer;
  certificatePath: string;
  issue(leafName: string, usage: 'server' | 'client', commonName?: string): Promise<IssuedCertificate>;
}

export interface DisposablePki {
  /** The root the rehearsal server trusts for client certificates. */
  root: TestAuthority;
  /** An unrelated root, for proving an untrusted issuer is refused. */
  foreignRoot: TestAuthority;
  directory: string;
  /** Remove all generated material. Safe to call more than once. */
  cleanup(): Promise<void>;
}

export async function requireOpenssl(): Promise<void> {
  try {
    await execFile('openssl', ['version']);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      throw new OperationalError(
        'openssl was not found on PATH',
        'The mutual-TLS rehearsal generates a disposable certificate authority with openssl. ' +
          'Install openssl, or run `fortress-csip demo` for the non-TLS sandbox.',
      );
    }
    throw new OperationalError(`could not run openssl: ${(error as Error).message}`);
  }
}

export async function createDisposablePki(): Promise<DisposablePki> {
  await requireOpenssl();

  // 0700 before anything is written into it: the private keys must never be world-readable,
  // even for the instant between creating the directory and tightening its mode.
  const directory = await mkdtemp(join(tmpdir(), 'fortress-csip-rehearsal-'));
  await chmodQuietly(directory, 0o700);

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await rm(directory, { recursive: true, force: true });
  };

  try {
    const root = await createAuthority(directory, 'rehearsal-root');
    const foreignRoot = await createAuthority(directory, 'rehearsal-foreign-root');
    return { root, foreignRoot, directory, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function createAuthority(directory: string, name: string): Promise<TestAuthority> {
  const keyPath = join(directory, `${name}.key.pem`);
  const certificatePath = join(directory, `${name}.cert.pem`);
  await openssl([
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
    '-days', String(VALIDITY_DAYS),
    // Conspicuously test-only: nobody should mistake this for an operational identity.
    // X.509 caps a common name at 64 characters, so the label stays terse.
    '-subj', `/CN=${commonNameFor(name)}`,
    '-keyout', keyPath, '-out', certificatePath,
  ]);
  await chmodQuietly(keyPath, 0o600);

  const certificate = await readFile(certificatePath);
  return {
    name,
    certificate,
    certificatePath,
    issue: (leafName, usage, commonName) =>
      issueLeaf(directory, { name, keyPath, certificatePath }, leafName, usage, commonName),
  };
}

async function issueLeaf(
  directory: string,
  authority: { name: string; keyPath: string; certificatePath: string },
  leafName: string,
  usage: 'server' | 'client',
  commonName = usage === 'server' ? 'localhost' : commonNameFor(leafName),
): Promise<IssuedCertificate> {
  const prefix = join(directory, `${authority.name}-${leafName}`);
  const keyPath = `${prefix}.key.pem`;
  const csrPath = `${prefix}.csr.pem`;
  const certificatePath = `${prefix}.cert.pem`;
  const extensionsPath = `${prefix}.ext`;

  // A server certificate needs a DNS SAN for `localhost`; a client certificate's SAN is
  // incidental, but keeping the shape identical avoids a second code path.
  await writeFile(extensionsPath, [
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    `extendedKeyUsage=${usage === 'server' ? 'serverAuth' : 'clientAuth'}`,
    `subjectAltName=DNS:${usage === 'server' ? 'localhost' : sanitizeSan(commonName)}`,
    '',
  ].join('\n'), { mode: 0o600 });

  await openssl([
    'req', '-newkey', 'rsa:2048', '-nodes', '-sha256',
    '-subj', `/CN=${commonName}`, '-keyout', keyPath, '-out', csrPath,
  ]);
  await chmodQuietly(keyPath, 0o600);
  await openssl([
    'x509', '-req', '-in', csrPath, '-sha256', '-days', String(VALIDITY_DAYS),
    '-CA', authority.certificatePath, '-CAkey', authority.keyPath, '-CAcreateserial',
    '-extfile', extensionsPath, '-out', certificatePath,
  ]);

  return {
    certificate: await readFile(certificatePath),
    privateKey: await readFile(keyPath),
    certificatePath,
    privateKeyPath: keyPath,
  };
}

async function openssl(args: string[]): Promise<void> {
  try {
    await execFile('openssl', args);
  } catch (error) {
    // openssl writes key-generation progress to stderr, so the first line is usually noise.
    // Prefer the line that actually names the failure.
    const lines = String((error as { stderr?: string }).stderr ?? (error as Error).message)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/^[.+*]+$/.test(line));
    const detail = lines.find((line) => /error|unable|cannot|failed/i.test(line)) ?? lines.at(-1);
    throw new OperationalError(
      `openssl ${args[0]} failed`,
      detail === undefined ? undefined : detail.slice(0, 300),
    );
  }
}

/** A conspicuously test-only common name, within X.509's 64-character limit. */
function commonNameFor(label: string): string {
  return `FORTRESS-CSIP REHEARSAL ${label} (NOT FOR PRODUCTION)`.slice(0, 64);
}

/** POSIX modes are advisory elsewhere; a failure to set them must not fail the rehearsal. */
async function chmodQuietly(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch {
    // Windows and some mounted filesystems do not implement POSIX modes.
  }
}

/** A SAN must be a DNS-shaped label; the conspicuous common names are not. */
function sanitizeSan(commonName: string): string {
  const label = commonName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${label.slice(0, 60) || 'rehearsal'}.invalid`;
}
