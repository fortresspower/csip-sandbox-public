import type { SerializedSession } from './session-store.js';

/**
 * The seam between the conformance harness and whoever performs operator actions.
 *
 * Two checks in the profile — assigning exactly one device to a program, and publishing a
 * bounded control — are things only the partner's own operator tooling can do. Fortress does
 * not standardize an admin endpoint for them and this toolkit must not invent one.
 *
 * So the harness never *performs* those actions. It describes what it needs and then polls
 * the CSIP graph for the observable result. In `--self-test` an in-repository driver performs
 * the action, because the example server's domain is right there; against a real partner a
 * guided driver prints instructions and waits. The checks either way are made from what the
 * IEEE 2030.5 connection shows, never from what the driver claims it did.
 */

export interface AssignmentRequest {
  kind: 'assignment';
  /** The device that must end up assigned. */
  targetLfdi: string;
  /** The device that must remain unassigned, so "exactly one" is observable. */
  otherLfdi: string;
  /** Friendly label the operator will recognize. */
  targetLabel: string;
}

export interface ControlRequest {
  kind: 'control';
  /** The exact mRID the harness will look for. */
  mRID: string;
  /** Epoch seconds. */
  start: number;
  durationSeconds: number;
  opModFixedW: number;
  targetLfdi: string;
  targetLabel: string;
}

export interface AssignmentMoveRequest {
  kind: 'assignment-move';
  fromLfdi: string;
  toLfdi: string;
  toLabel: string;
}

export type OperatorInstruction = AssignmentRequest | ControlRequest | AssignmentMoveRequest;

export interface OperatorDriver {
  /**
   * Make the requested state happen, or ask a human to.
   *
   * Returning does not mean the state exists — the harness always confirms by polling the
   * connection. A driver that cannot arrange the action should return anyway and let the
   * poll time out with a `manual` check.
   */
  request(instruction: OperatorInstruction): Promise<void>;
  /** How long the harness should poll for the described state. */
  pollTimeoutMs: number;
  /** Delay between polls. */
  pollIntervalMs: number;
  /**
   * Create a second connection that reuses this run's program and control identifiers.
   *
   * Only the self-test can do this: against a real partner it would mean asking them to
   * provision a second aggregator connection mid-run, which the profile does not require.
   * Returning false leaves `isolation.connection-scope` skipped.
   */
  seedOverlappingConnection?(mRID: string): Promise<boolean>;
}

/** The two synthetic devices the harness registers. Test-only identities it derives itself. */
export interface SyntheticDevices {
  alpha: { lfdi: string; label: string };
  beta: { lfdi: string; label: string };
}

/** Persisted between runs so an operator pause does not force re-registration. */
export interface ConformanceSessionFile {
  schema: 'fortress-csip-conformance-session/v1';
  createdAt: string;
  updatedAt: string;
  /** Origin this session belongs to, so a session file is not silently reused elsewhere. */
  origin: string;
  devices: SyntheticDevices;
  /** Generated rehearsal control parameters, so a resumed run looks for the same mRID. */
  control?: {
    mRID: string;
    start: number;
    durationSeconds: number;
    opModFixedW: number;
  };
  /** client-core session effects, needed to prove restart idempotency and owed responses. */
  clientSession?: SerializedSession;
}
