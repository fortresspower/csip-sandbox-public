import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkPublicBoundary,
  formatFindings,
  isPartnerFacing,
  isScannablePath,
  loadTerms,
  scanText,
} from '../scripts/check-public-boundary.mjs';

const execFile = promisify(execFileCallback);
const terms = loadTerms();

// Forbidden terms are assembled at runtime so that this test file does not itself contain the
// literal strings the checker forbids — otherwise the repository scan would flag the test.
const PRIVATE_REPOSITORY = ['cm', 'sandbox'].join('');
const PRIVATE_EMULATOR = ['HIL', 'DA'].join('');
const PRIVATE_DISPATCH = ['ra', 'command'].join('-');
const INTERNAL_PRODUCT = ['F', 'M', 'P'].join('');
const DEPLOYMENT_TOOL = ['Terra', 'form'].join('');
const INTERNAL_PROCESS = ['manager', 'restart'].join(' ');

describe('public-boundary term matching', () => {
  it('flags a private repository name anywhere in the tree', () => {
    const findings = scanText('packages/client-core/src/thing.ts', `// see ${PRIVATE_REPOSITORY}\n`, terms);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: 'packages/client-core/src/thing.ts', line: 1 });
    expect(findings[0].why).toContain('private Fortress repository');
  });

  it('matches private terms case-insensitively', () => {
    expect(scanText('a.md', PRIVATE_EMULATOR.toLowerCase(), terms)).toHaveLength(1);
    expect(scanText('a.md', PRIVATE_EMULATOR, terms)).toHaveLength(1);
  });

  it('reports each occurrence with its line number', () => {
    const text = `clean line\n${PRIVATE_DISPATCH} here\nclean\n${PRIVATE_EMULATOR} there\n`;
    const findings = scanText('docs/partner/x.md', text, terms);
    expect(findings.map((finding) => finding.line)).toEqual([2, 4]);
  });

  it('requires word boundaries for the internal product acronym', () => {
    expect(scanText('a.md', `an ${INTERNAL_PRODUCT}-style drawer`, terms)).toHaveLength(1);
    // A longer token that merely contains those letters is not a violation.
    expect(scanText('a.md', `SOME${INTERNAL_PRODUCT}THING`, terms)).toEqual([]);
  });

  it('passes clean partner text', () => {
    const text = 'Fortress acts as the IEEE 2030.5 client. Your system hosts the server.\n';
    expect(scanText('README.md', text, terms)).toEqual([]);
    expect(scanText('docs/partner/onboarding.md', text, terms)).toEqual([]);
  });
});

describe('partner-facing scope', () => {
  it('treats README, docs, and the browser console as partner-facing', () => {
    for (const path of ['README.md', 'docs/README.md', 'docs/partner/onboarding.md',
      'packages/example-server/public/console/tabs.jsx']) {
      expect(isPartnerFacing(path, terms.partnerFacingPaths)).toBe(true);
    }
  });

  it('does not treat package source or tests as partner-facing', () => {
    for (const path of ['packages/client-core/src/transport.ts', 'scripts/gen-catalog.mjs',
      'packages/example-server/test/partner-loop.test.ts']) {
      expect(isPartnerFacing(path, terms.partnerFacingPaths)).toBe(false);
    }
  });

  it('forbids deployment and internal-process wording only on partner-facing surfaces', () => {
    expect(scanText('docs/partner/onboarding.md', `provisioned with ${DEPLOYMENT_TOOL}`, terms)).toHaveLength(1);
    expect(scanText('docs/partner/x.md', `survives ${INTERNAL_PROCESS}`, terms)).toHaveLength(1);

    // The same words in package source are legitimate and must not fail the build.
    expect(scanText('packages/client-core/src/transport.ts', `provisioned with ${DEPLOYMENT_TOOL}`, terms)).toEqual([]);
    expect(scanText('packages/client-core/src/session.ts', `survives ${INTERNAL_PROCESS}`, terms)).toEqual([]);
  });

  it('does not forbid the bare words that appear in legitimate code', () => {
    const text = 'const internalEventId = connection.manager.id;\n';
    expect(scanText('docs/partner/onboarding.md', text, terms)).toEqual([]);
  });
});

describe('scan scope', () => {
  it('skips dependencies, build output, generated TLS, and the lockfile', () => {
    for (const path of ['node_modules/pkg/index.js', 'packages/client-core/dist/index.js',
      'release/bundle.tgz', 'tls/root.pem', 'package-lock.json']) {
      expect(isScannablePath(path)).toBe(false);
    }
  });

  it('skips binary assets', () => {
    expect(isScannablePath('packages/example-server/public/fortress-logo.png')).toBe(false);
  });

  it('skips its own term data so the forbidden list can be written down', () => {
    expect(isScannablePath('scripts/public-boundary-terms.json')).toBe(false);
  });

  it('scans ordinary source and documentation', () => {
    for (const path of ['README.md', 'docs/partner/onboarding.md',
      'packages/client-core/src/transport.ts', 'scripts/gen-catalog.mjs']) {
      expect(isScannablePath(path)).toBe(true);
    }
  });
});

describe('repository scan', () => {
  let seeded: string;

  beforeAll(async () => {
    seeded = await mkdtemp(join(tmpdir(), 'boundary-fixture-'));
    await mkdir(join(seeded, 'docs', 'partner'), { recursive: true });
    await writeFile(join(seeded, 'clean.md'), 'Fortress is the client; the partner hosts the server.\n');
    await writeFile(join(seeded, 'docs', 'partner', 'leaky.md'),
      `The bundle is promoted into ${PRIVATE_REPOSITORY}.\nAn owed response survives ${INTERNAL_PROCESS}.\n`);
    await execFile('git', ['init', '-q'], { cwd: seeded });
    await execFile('git', ['add', '-A'], { cwd: seeded });
  });

  afterAll(async () => rm(seeded, { recursive: true, force: true }));

  it('fails on a seeded fixture repository', () => {
    const findings = checkPublicBoundary({ root: seeded });
    expect(findings.map((finding) => `${finding.file}:${finding.line}`))
      .toEqual(['docs/partner/leaky.md:1', 'docs/partner/leaky.md:2']);
  });

  it('formats findings with file, line, term, and remediation', () => {
    const rendered = formatFindings(checkPublicBoundary({ root: seeded }));
    expect(rendered).toContain('docs/partner/leaky.md:1');
    expect(rendered).toContain('private Fortress repository');
    expect(rendered).toContain('2 violations');
  });

  it('passes on this repository', () => {
    expect(checkPublicBoundary()).toEqual([]);
  });

  it('exits nonzero from the command line when a violation exists', async () => {
    const script = new URL('../scripts/check-public-boundary.mjs', import.meta.url).pathname;
    await expect(execFile(process.execPath, [script, '--root', seeded])).rejects.toMatchObject({ code: 1 });
  });

  it('exits zero from the command line on a clean tree', async () => {
    const script = new URL('../scripts/check-public-boundary.mjs', import.meta.url).pathname;
    const { stdout } = await execFile(process.execPath, [script]);
    expect(stdout).toContain('no forbidden Fortress-private language found');
  });
});
