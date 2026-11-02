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
        if (days === 0) {
          // Historical dates make expiry deterministic, independent of test timing.
          const database = join(dir, `${name}-${leafName}.index`);
          const serial = join(dir, `${name}-${leafName}.serial`);
          const config = join(dir, `${name}-${leafName}.cnf`);
          writeFileSync(database, '');
          writeFileSync(serial, '01\n');
          writeFileSync(config, [
            '[ca]', 'default_ca=test', '[test]',
            `database=${database}`, `serial=${serial}`, `new_certs_dir=${dir}`,
            `certificate=${certPath}`, `private_key=${keyPath}`,
            'default_md=sha256', 'policy=subject', '[subject]', 'commonName=supplied', '',
          ].join('\n'));
          openssl([
            'ca', '-batch', '-config', config, '-in', csr, '-out', leafCert,
            '-notext', '-extfile', extensions,
            '-startdate', '20000101000000Z', '-enddate', '20000102000000Z',
          ]);
        } else {
          openssl([
            'x509', '-req', '-sha256', '-days', String(days), '-in', csr,
            '-CA', certPath, '-CAkey', keyPath, '-CAserial', join(dir, `${name}.srl`),
            '-CAcreateserial', '-extfile', extensions, '-out', leafCert,
          ]);
        }
        return {
          certificate: readFileSync(leafCert),
          privateKey: readFileSync(leafKey),
        };
      },
    };
  };

  try {
    return {
      root: authority('primary'),
      otherRoot: authority('other'),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
