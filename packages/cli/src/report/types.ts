/**
 * The one report model shared by `doctor` and `conformance`.
 *
 * A partner sends this artifact to Fortress, so two properties matter more than convenience:
 * the shape is stable (check IDs are an interface, not log text), and it can carry nothing
 * secret. Both are enforced — the schema is checked in at
 * `schemas/fortress-csip-evidence-v1.schema.json`, and every string that reaches a report goes
 * through the bounding in `report.ts`.
 */

export const REPORT_SCHEMA = 'fortress-csip-evidence/v1';
export const REPORT_PROFILE = 'fortress-csip-polling/v1';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip' | 'manual';

export type ReportKind = 'doctor' | 'conformance' | 'mtls-rehearsal';

/** How the target was reached, which determines which transport rules were enforced. */
export type TargetMode = 'deployed' | 'local';

export interface CheckResult {
  /** Stable identifier, e.g. `graph.device-capability`. Never renamed once published. */
  id: string;
  /** Leading segment of the id, for grouping in output. */
  category: string;
  status: CheckStatus;
  /** One bounded sentence stating what was observed. */
  summary: string;
  /** What the partner should change. Present on `fail` and usually on `warn`. */
  remediation?: string;
  /** For a `manual` check: the operator action this check is waiting on. */
  action?: string;
}

export interface ReportSummary {
  /** `pass` only when nothing failed; `warn` when the worst outcome is a warning. */
  status: 'pass' | 'warn' | 'fail';
  pass: number;
  warn: number;
  fail: number;
  skip: number;
  manual: number;
}

export interface ReportTarget {
  /** Origin exactly as the partner supplied it. */
  origin: string;
  deviceCapabilityPath: string;
  mode: TargetMode;
}

/** Identity metadata, all of it derivable from the public certificate. */
export interface ReportIdentity {
  aggregatorLfdi: string;
  certificateFingerprintSha256: string;
  certificateNotAfter: string;
}

export interface Report {
  schema: typeof REPORT_SCHEMA;
  kind: ReportKind;
  profile: typeof REPORT_PROFILE;
  /** ISO-8601 UTC. */
  generatedAt: string;
  tool: { name: string; version: string };
  target: ReportTarget;
  identity?: ReportIdentity;
  summary: ReportSummary;
  checks: CheckResult[];
}
