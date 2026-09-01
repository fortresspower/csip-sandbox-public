import { TOOL_NAME, TOOL_VERSION } from '../version.js';
import {
  REPORT_PROFILE,
  REPORT_SCHEMA,
  type CheckResult,
  type CheckStatus,
  type Report,
  type ReportIdentity,
  type ReportKind,
  type ReportSummary,
  type ReportTarget,
} from './types.js';

/** Longest message the report will carry. Long enough to be useful, short enough to be safe. */
const MAX_MESSAGE = 400;

/**
 * Patterns that must never reach a report, whatever a check tried to put there.
 *
 * This is a backstop, not the primary defence — checks are written not to include payloads in
 * the first place. It exists because the cost of one leak into an artifact a partner emails
 * onward is high, and the cost of this check is a regex per string.
 */
const FORBIDDEN_CONTENT: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /-----BEGIN[\s\S]*?-----END[^-]*-----/g, replacement: '[redacted PEM]' },
  { pattern: /-----BEGIN [A-Z ]+-----/g, replacement: '[redacted PEM]' },
  { pattern: /<\?xml[\s\S]*/gi, replacement: '[redacted XML]' },
  { pattern: /<[A-Za-z][A-Za-z0-9:]*[\s>][\s\S]*/g, replacement: '[redacted XML]' },
];

/**
 * Bound and sanitize one message.
 *
 * Collapses whitespace so a multi-line payload cannot smuggle structure into the report,
 * strips anything matching a forbidden pattern, then truncates.
 */
export function boundMessage(value: string, maxLength = MAX_MESSAGE): string {
  let text = value;
  for (const { pattern, replacement } of FORBIDDEN_CONTENT) {
    text = text.replace(pattern, replacement);
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/**
 * Accumulates checks in the order they ran and produces the finished report.
 *
 * Checks are appended, never mutated after the fact, so the report reads as a transcript of
 * what actually happened rather than a summary reconstructed at the end.
 */
export class ReportBuilder {
  readonly #checks: CheckResult[] = [];
  readonly #kind: ReportKind;
  readonly #target: ReportTarget;
  #identity?: ReportIdentity;

  constructor(kind: ReportKind, target: ReportTarget) {
    this.#kind = kind;
    this.#target = target;
  }

  /** Record identity once it is known. Only public certificate metadata is accepted. */
  setIdentity(identity: ReportIdentity): void {
    this.#identity = {
      aggregatorLfdi: identity.aggregatorLfdi,
      certificateFingerprintSha256: identity.certificateFingerprintSha256,
      certificateNotAfter: identity.certificateNotAfter,
    };
  }

  add(
    id: string,
    status: CheckStatus,
    summary: string,
    extra: { remediation?: string; action?: string } = {},
  ): CheckResult {
    const check: CheckResult = {
      id,
      category: id.split('.')[0],
      status,
      summary: boundMessage(summary),
      ...(extra.remediation === undefined
        ? {}
        : { remediation: boundMessage(extra.remediation) }),
      ...(extra.action === undefined ? {} : { action: boundMessage(extra.action) }),
    };
    this.#checks.push(check);
    return check;
  }

  pass(id: string, summary: string): CheckResult {
    return this.add(id, 'pass', summary);
  }

  fail(id: string, summary: string, remediation: string): CheckResult {
    return this.add(id, 'fail', summary, { remediation });
  }

  warn(id: string, summary: string, remediation?: string): CheckResult {
    return this.add(id, 'warn', summary, { remediation });
  }

  skip(id: string, summary: string): CheckResult {
    return this.add(id, 'skip', summary);
  }

  /** True when nothing has failed so far. Lets a phase stop before a dependent phase runs. */
  get healthy(): boolean {
    return !this.#checks.some((check) => check.status === 'fail');
  }

  /**
   * Settle a check that an earlier phase could not determine.
   *
   * Only a `skip` may be resolved, and only once. A skip is a statement that the check was
   * *not decided*, so filling it in from a later probe is completing the record rather than
   * rewriting it — which is why every other status is left alone. This exists because the
   * anonymous probe cannot see redirects or response size on a server that correctly refuses
   * anonymous clients, but the authenticated read can.
   */
  resolveSkipped(
    id: string,
    status: CheckStatus,
    summary: string,
    remediation?: string,
  ): void {
    const existing = this.#checks.find((check) => check.id === id);
    if (existing === undefined || existing.status !== 'skip') return;
    existing.status = status;
    existing.summary = boundMessage(summary);
    if (remediation !== undefined) existing.remediation = boundMessage(remediation);
  }

  has(id: string): boolean {
    return this.#checks.some((check) => check.id === id);
  }

  build(generatedAt: Date): Report {
    return {
      schema: REPORT_SCHEMA,
      kind: this.#kind,
      profile: REPORT_PROFILE,
      generatedAt: generatedAt.toISOString(),
      tool: { name: TOOL_NAME, version: TOOL_VERSION },
      target: this.#target,
      ...(this.#identity === undefined ? {} : { identity: this.#identity }),
      summary: summarize(this.#checks),
      checks: [...this.#checks],
    };
  }
}

export function summarize(checks: readonly CheckResult[]): ReportSummary {
  const count = (status: CheckStatus) =>
    checks.filter((check) => check.status === status).length;
  const fail = count('fail');
  const warn = count('warn');
  return {
    // A manual check that has not been satisfied is not a pass, but it is also not a
    // failure — it is work the operator still owes. It never lifts the overall status.
    status: fail > 0 ? 'fail' : warn > 0 ? 'warn' : 'pass',
    pass: count('pass'),
    warn,
    fail,
    skip: count('skip'),
    manual: count('manual'),
  };
}

/** Serialize with stable key order and a trailing newline, for reproducible artifacts. */
export function serializeReport(report: Report): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
