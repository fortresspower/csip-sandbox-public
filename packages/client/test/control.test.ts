import { describe, it, expect } from 'vitest';
import { SyntheticGenerator } from '../src/generator.js';
import { applyControl } from '../src/control.js';
import type { DERControl } from '@fortress-csip/protocol';

const make = (base: DERControl['DERControlBase']): DERControl => ({
  mRID: 'C1', creationTime: 0, EventStatus: { currentStatus: 1 }, interval: { start: 0, duration: 600 }, DERControlBase: base,
});

describe('applyControl', () => {
  it('opModConnect=false disconnects (power -> 0)', () => {
    const g = new SyntheticGenerator({ lFDI: 'S', nameplateW: 5000, capacityWh: 13500, initialSoC: 50 });
    applyControl(g, make({ opModConnect: false }));
    expect(g.snapshot().connected).toBe(false);
    expect(g.snapshot().realPowerW).toBe(0);
  });

  it('opModMaxLimW clamps reported power', () => {
    const g = new SyntheticGenerator({ lFDI: 'S', nameplateW: 5000, capacityWh: 13500, initialSoC: 50 });
    g.setDischargeSetpoint(5000);
    applyControl(g, make({ opModMaxLimW: 2000 }));
    expect(Math.abs(g.snapshot().realPowerW)).toBeLessThanOrEqual(2000);
  });

  it('opModFixedW negative sets discharge', () => {
    const g = new SyntheticGenerator({ lFDI: 'S', nameplateW: 5000, capacityWh: 13500, initialSoC: 50 });
    applyControl(g, make({ opModFixedW: -3000 }));
    expect(g.snapshot().realPowerW).toBeLessThan(0);
  });
});
