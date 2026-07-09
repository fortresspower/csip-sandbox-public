import type { DERControl } from '@fortress-csip/protocol';
import type { SyntheticGenerator } from './generator.js';

/** Apply a DERControl's base modes to the generator. Returns a human label for logs/responses. */
export function applyControl(g: SyntheticGenerator, c: DERControl): string {
  const b = c.DERControlBase;
  const applied: string[] = [];
  if (b.opModConnect !== undefined) { g.setConnected(b.opModConnect); applied.push(`connect=${b.opModConnect}`); }
  if (b.opModMaxLimW !== undefined) { g.setMaxLimitW(b.opModMaxLimW); applied.push(`maxLimW=${b.opModMaxLimW}`); }
  if (b.opModFixedW !== undefined) {
    if (b.opModFixedW < 0) g.setDischargeSetpoint(b.opModFixedW); else g.setChargeSetpoint(b.opModFixedW);
    applied.push(`fixedW=${b.opModFixedW}`);
  }
  return `${c.mRID}: ${applied.join(', ') || 'no-op'}`;
}
