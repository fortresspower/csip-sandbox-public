import type { Io } from '../io.js';
import type { CheckStatus, Report } from './types.js';

/**
 * Human rendering of a report.
 *
 * The goal is that a partner can act on the output without opening the JSON: each line names
 * the check, says what was observed, and — when something is wrong — says what to change.
 */

const LABEL: Record<CheckStatus, string> = {
  pass: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
  skip: 'SKIP',
  manual: 'TODO',
};

export function renderReport(report: Report, io: Io): void {
  const idWidth = Math.max(...report.checks.map((check) => check.id.length), 20);

  for (const check of report.checks) {
    io.out(`${LABEL[check.status]}  ${check.id.padEnd(idWidth + 2)}${check.summary}`);
    if (check.remediation !== undefined) {
      io.out(`${' '.repeat(6)}Remediation: ${check.remediation}`);
    }
    if (check.action !== undefined) {
      io.out(`${' '.repeat(6)}Action: ${check.action}`);
    }
  }

  io.out('');
  if (report.identity !== undefined) {
    io.out(`Client identity: ${report.identity.aggregatorLfdi}`);
    io.out(`Expires:         ${report.identity.certificateNotAfter}`);
    io.out('');
  }
  io.out(`Result: ${verdict(report)} (${counts(report)})`);

  // A run where most checks were skipped can read as a clean bill of health, which it is not.
  // Say plainly that coverage was partial and what each skip is waiting on.
  if (report.summary.skip > 0 && report.summary.fail === 0) {
    io.out('');
    io.out(
      `${report.summary.skip} check(s) did not run. Each SKIP line above says what it needs.`,
    );
  }
}

/**
 * The one-word answer.
 *
 * `doctor` answers "can Fortress connect and discover the required graph"; `conformance`
 * answers "does this server meet the profile". Both reduce to ready / not ready, because that
 * is the decision the partner is actually making.
 */
function verdict(report: Report): string {
  if (report.summary.fail > 0) return 'NOT READY';
  if (report.summary.manual > 0) return 'INCOMPLETE';
  // Skips are not failures, but a run that could not reach most of its checks has not shown
  // readiness either — most often because no client identity was supplied.
  if (report.summary.skip > report.summary.pass) return 'INCONCLUSIVE';
  if (report.summary.warn > 0) return 'READY WITH WARNINGS';
  return 'READY';
}

function counts(report: Report): string {
  const parts: string[] = [];
  const { pass, warn, fail, skip, manual } = report.summary;
  if (fail > 0) parts.push(`${fail} failed`);
  if (warn > 0) parts.push(`${warn} warning${warn === 1 ? '' : 's'}`);
  if (manual > 0) parts.push(`${manual} awaiting operator action`);
  if (skip > 0) parts.push(`${skip} skipped`);
  parts.push(`${pass} passed`);
  return parts.join(', ');
}
