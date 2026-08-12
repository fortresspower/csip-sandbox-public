import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestCertificate {
  certificate: Buffer;
  privateKey: Buffer;
}

export interface TestAuthority {
  certificate: Buffer;
  issue(
    name: string,
    usage: 'server' | 'client',
    commonName?: string,
    days?: number,
  ): TestCertificate;
}

export interface TestPki {
  root: TestAuthority;
  otherRoot: TestAuthority;
  cleanup(): void;
}

function openssl(args: string[]): void {
  execFileSync('openssl', args, { stdio: 'ignore' });
}

export function makeTestPki(): TestPki {
  const dir = mkdtempSync(join(tmpdir(), 'csip-client-core-pki-'));

  const authority = (name: string): TestAuthority => {
    const keyPath = join(dir, `${name}.key.pem`);
    const certPath = join(dir, `${name}.cert.pem`);
    openssl([
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2',
      '-subj', `/CN=${name} Test Root`, '-keyout', keyPath, '-out', certPath,
    ]);

    return {
      certificate: readFileSync(certPath),
      issue(
        leafName: string,
        usage: 'server' | 'client',
        commonName = usage === 'server' ? 'localhost' : leafName,
        days = 2,
      ): TestCertificate {
        const leafKey = join(dir, `${name}-${leafName}.key.pem`);
        const csr = join(dir, `${name}-${leafName}.csr.pem`);
        const leafCert = join(dir, `${name}-${leafName}.cert.pem`);
        const extensions = join(dir, `${name}-${leafName}.ext`);
        writeFileSync(extensions, [
          'basicConstraints=critical,CA:FALSE',
          'keyUsage=critical,digitalSignature,keyEncipherment',
          `extendedKeyUsage=${usage === 'server' ? 'serverAuth' : 'clientAuth'}`,
          `subjectAltName=DNS:${commonName}`,
          '',
        ].join('\n'));
        openssl([
          'req', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', `/CN=${commonName}`,
          '-keyout', leafKey, '-out', csr,
        ]);
        openssl([
          'x509', '-req', '-sha256', '-days', String(days), '-in', csr,
          '-CA', certPath, '-CAkey', keyPath, '-CAserial', join(dir, `${name}.srl`),
          '-CAcreateserial', '-extfile', extensions, '-out', leafCert,
        ]);
        return {
          certificate: readFileSync(leafCert),
          privateKey: readFileSync(leafKey),
        };
      },
    };
  };

  return {
    root: authority('primary'),
    otherRoot: authority('other'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
