import type { Io } from '../io.js';
import type { OperatorDriver, OperatorInstruction } from './types.js';

/**
 * The guided driver used against a real partner endpoint.
 *
 * It cannot perform anything: assignment and control authoring live behind the partner's own
 * authenticated operator boundary, and this toolkit deliberately does not ask them to expose
 * an admin API for its benefit. So it prints exactly what is needed, in the partner's own
 * vocabulary, and the harness then watches the CSIP connection for the result.
 */
export function guidedOperatorDriver(
  io: Io,
  options: { pollTimeoutMs?: number; pollIntervalMs?: number } = {},
): OperatorDriver {
  const pollTimeoutMs = options.pollTimeoutMs ?? 10 * 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;

  return {
    pollTimeoutMs,
    pollIntervalMs,
    async request(instruction: OperatorInstruction): Promise<void> {
      // Instructions go to stderr, so that --json stdout stays machine-readable while a
      // human still sees what they are being asked to do.
      for (const line of describeInstruction(instruction, pollTimeoutMs)) io.err(line);
    },
  };
}

export function describeInstruction(
  instruction: OperatorInstruction,
  pollTimeoutMs: number,
): string[] {
  const minutes = Math.round(pollTimeoutMs / 60_000);
  const waiting = [
    '',
    `The toolkit will poll for up to ${minutes} minute(s). No Fortress-specific admin`,
    'endpoint is required — use whatever tooling you normally use.',
    '',
  ];

  if (instruction.kind === 'assignment') {
    return [
      '',
      'ACTION REQUIRED',
      '',
      'Two synthetic EndDevices are now registered.',
      `Using your normal operator tooling, assign only test device "${instruction.targetLabel}"`,
      'to a DERProgram intended for this rehearsal.',
      '',
      `  assign:      ${instruction.targetLabel}`,
      `  leave alone: the second test device`,
      ...waiting,
    ];
  }

  if (instruction.kind === 'control') {
    return [
      '',
      'ACTION REQUIRED',
      '',
      'Publish one bounded rehearsal control to the assigned test device, with exactly',
      'these parameters:',
      '',
      `  mRID:              ${instruction.mRID}`,
      `  target:            ${instruction.targetLabel}`,
      `  start (epoch s):   ${instruction.start}`,
      `  duration:          ${instruction.durationSeconds} seconds`,
      `  opModFixedW:       ${instruction.opModFixedW} W`,
      '  responseRequired:  request accepted, started, and terminal responses',
      '  replyTo:           a same-origin link that accepts DERControlResponse',
      ...waiting,
    ];
  }

  return [
    '',
    'ACTION REQUIRED',
    '',
    `Move the rehearsal assignment to test device "${instruction.toLabel}", leaving the`,
    'first test device unassigned. No Fortress-side membership edit is involved —',
    'the change must be visible purely through discovery.',
    ...waiting,
  ];
}
