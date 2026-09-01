import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ReportBuilder, boundMessage, serializeReport, summarize } from '../src/report/report.js';
import { renderReport } from '../src/report/render.js';
import { validateAgainstSchema } from '../src/report/validate.js';
import type { CheckResult } from '../src/report/types.js';
import { createMemoryIo } from '../src/io.js';
import { REPOSITORY_ROOT } from './support/context.js';

let schema: unknown;

beforeAll(async () => {
  schema = JSON.parse(
    await readFile(join(REPOSITORY_ROOT, 'schemas/fortress-csip-evidence-v1.schema.json'), 'utf8'),
  );
});

function builder(): ReportBuilder {
  return new ReportBuilder('doctor', {
    origin: 'https://csip.partner.example',
    deviceCapabilityPath: '/sep2/capability',
    mode: 'deployed',
  });
}

describe('message bounding', () => {
  it('strips a PEM body', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----';
    expect(boundMessage(`failed with ${pem}`)).not.toContain('MIIB');
    expect(boundMessage(`failed with ${pem}`)).toContain('[redacted PEM]');
  });

  it('strips a private key block', () => {
    const key = '-----BEGIN PRIVATE KEY-----\nsecretbytes\n-----END PRIVATE KEY-----';
    expect(boundMessage(key)).not.toContain('secretbytes');
  });

  it('strips a raw XML payload', () => {
    const xml = '<?xml version="1.0"?><EndDeviceList><lFDI>abc</lFDI></EndDeviceList>';
    expect(boundMessage(`parse failed: ${xml}`)).not.toContain('lFDI');
  });

  it('strips a bare XML element', () => {
    expect(boundMessage('got <DeviceCapability pollRate="300"/>')).toContain('[redacted XML]');
  });

  it('collapses whitespace so a payload cannot smuggle structure in', () => {
    expect(boundMessage('a\n\n  b\tc')).toBe('a b c');
  });

  it('truncates past the limit', () => {
    const long = 'x'.repeat(1000);
    expect(boundMessage(long).length).toBeLessThanOrEqual(400);
    expect(boundMessage(long).endsWith('…')).toBe(true);
  });
});

describe('report building', () => {
  it('records checks in the order they ran', () => {
    const report = builder();
    report.pass('origin.valid', 'first');
    report.fail('origin.https', 'second', 'fix it');
    report.skip('mtls.required', 'third');
    expect(report.build(new Date()).checks.map((check) => check.id))
      .toEqual(['origin.valid', 'origin.https', 'mtls.required']);
  });

  it('derives the category from the check id', () => {
    const report = builder();
    report.pass('graph.device-capability', 'ok');
    expect(report.build(new Date()).checks[0].category).toBe('graph');
  });

  it('bounds every string that reaches a check', () => {
    const report = builder();
    report.fail('graph.device-capability', '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----', 'x'.repeat(900));
    const check = report.build(new Date()).checks[0];
    expect(check.summary).not.toContain('AAA');
    expect(check.remediation!.length).toBeLessThanOrEqual(400);
  });

  it('reports healthy until something fails', () => {
    const report = builder();
    report.pass('origin.valid', 'ok');
    report.warn('origin.https', 'hmm');
    report.skip('mtls.required', 'later');
    expect(report.healthy).toBe(true);
    report.fail('graph.namespace', 'no', 'fix');
    expect(report.healthy).toBe(false);
  });
});

describe('resolving an undetermined check', () => {
  it('settles a skip', () => {
    const report = builder();
    report.skip('transport.no-redirect', 'not determined');
    report.resolveSkipped('transport.no-redirect', 'fail', 'redirected', 'stop redirecting');
    const check = report.build(new Date()).checks[0];
    expect(check.status).toBe('fail');
    expect(check.remediation).toBe('stop redirecting');
  });

  it('leaves a decided check alone, whatever its status', () => {
    for (const seed of ['pass', 'fail', 'warn'] as const) {
      const report = builder();
      if (seed === 'pass') report.pass('transport.no-redirect', 'decided');
      if (seed === 'fail') report.fail('transport.no-redirect', 'decided', 'fix');
      if (seed === 'warn') report.warn('transport.no-redirect', 'decided');
      report.resolveSkipped('transport.no-redirect', 'pass', 'overwritten');
      const check = report.build(new Date()).checks[0];
      expect(check.status).toBe(seed);
      expect(check.summary).toBe('decided');
    }
  });

  it('ignores an id that was never recorded', () => {
    const report = builder();
    report.resolveSkipped('never.recorded', 'pass', 'nothing');
    expect(report.build(new Date()).checks).toEqual([]);
  });
});

describe('summary', () => {
  const check = (status: CheckResult['status']): CheckResult =>
    ({ id: 'a.b', category: 'a', status, summary: 's' });

  it('fails when anything failed', () => {
    expect(summarize([check('pass'), check('warn'), check('fail')]).status).toBe('fail');
  });

  it('warns when the worst outcome is a warning', () => {
    expect(summarize([check('pass'), check('warn'), check('skip')]).status).toBe('warn');
  });

  it('passes when nothing failed or warned', () => {
    expect(summarize([check('pass'), check('skip')]).status).toBe('pass');
  });

  it('does not let an outstanding manual action count as a pass', () => {
    const summary = summarize([check('pass'), check('manual')]);
    expect(summary.manual).toBe(1);
    expect(summary.pass).toBe(1);
  });
});

describe('rendering', () => {
  it('shows status, id, summary, and remediation', () => {
    const report = builder();
    report.fail('client-certificate.authorized', 'LFDI is not allowlisted', 'allowlist it');
    const io = createMemoryIo();
    renderReport(report.build(new Date()), io);
    const out = io.stdout.join('\n');
    expect(out).toContain('FAIL');
    expect(out).toContain('client-certificate.authorized');
    expect(out).toContain('LFDI is not allowlisted');
    expect(out).toContain('Remediation: allowlist it');
  });

  it('says NOT READY when a check failed', () => {
    const report = builder();
    report.fail('origin.https', 'not https', 'use https');
    const io = createMemoryIo();
    renderReport(report.build(new Date()), io);
    expect(io.stdout.join('\n')).toContain('NOT READY');
  });

  it('says READY when everything passed', () => {
    const report = builder();
    report.pass('origin.https', 'https');
    const io = createMemoryIo();
    renderReport(report.build(new Date()), io);
    expect(io.stdout.join('\n')).toContain('Result: READY');
  });

  it('says INCOMPLETE while an operator action is outstanding', () => {
    const report = builder();
    report.pass('origin.https', 'https');
    report.add('assignment.exactly-one-target', 'manual', 'waiting', { action: 'assign one device' });
    const io = createMemoryIo();
    renderReport(report.build(new Date()), io);
    const out = io.stdout.join('\n');
    expect(out).toContain('INCOMPLETE');
    expect(out).toContain('Action: assign one device');
  });
});

describe('schema conformance', () => {
  it('validates a report with every status represented', () => {
    const report = builder();
    report.pass('origin.valid', 'ok');
    report.warn('origin.https', 'hmm', 'consider');
    report.fail('mtls.required', 'anonymous succeeded', 'require mTLS');
    report.skip('graph.namespace', 'not reached');
    report.add('assignment.exactly-one-target', 'manual', 'waiting', { action: 'do a thing' });
    report.setIdentity({
      aggregatorLfdi: '0123456789abcdef0123456789abcdef01234567',
      certificateFingerprintSha256: 'a'.repeat(64),
      certificateNotAfter: '2027-09-01T00:00:00.000Z',
    });
    expect(validateAgainstSchema(report.build(new Date()), schema)).toEqual([]);
  });

  it('rejects a malformed check id', () => {
    const bad = { ...builder().build(new Date()), checks: [
      { id: 'NotAValidId', category: 'x', status: 'pass', summary: 's' },
    ] };
    expect(validateAgainstSchema(bad, schema).length).toBeGreaterThan(0);
  });

  it('rejects an unexpected property', () => {
    const bad = { ...builder().build(new Date()), surprise: 'extra' };
    expect(validateAgainstSchema(bad, schema)[0].message).toContain('not an allowed property');
  });

  it('rejects a non-hex LFDI', () => {
    const report = builder();
    report.setIdentity({
      aggregatorLfdi: 'NOT-HEX',
      certificateFingerprintSha256: 'a'.repeat(64),
      certificateNotAfter: '2027-09-01T00:00:00.000Z',
    });
    expect(validateAgainstSchema(report.build(new Date()), schema).length).toBeGreaterThan(0);
  });

  it('flags a schema keyword the validator does not implement', () => {
    // Guards against the schema growing a constraint this validator silently ignores.
    const violations = validateAgainstSchema({}, { type: 'object', oneOf: [] });
    expect(violations.some((entry) => entry.message.includes('unsupported keyword'))).toBe(true);
  });

  it('understands every keyword the checked-in schema actually uses', () => {
    expect(validateAgainstSchema(builder().build(new Date()), schema)).toEqual([]);
  });
});

describe('serialization', () => {
  it('is stable and newline-terminated', () => {
    const report = builder().build(new Date('2026-09-01T14:00:00.000Z'));
    const first = serializeReport(report);
    expect(first).toBe(serializeReport(report));
    expect(first.endsWith('\n')).toBe(true);
    expect(JSON.parse(first).generatedAt).toBe('2026-09-01T14:00:00.000Z');
  });
});
