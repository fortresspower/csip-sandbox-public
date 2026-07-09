import { describe, it, expect } from 'vitest';
import { SyntheticGenerator } from '../src/generator.js';

describe('SyntheticGenerator', () => {
  it('produces a real-power reading and a SoC within [0,100]', () => {
    const g = new SyntheticGenerator({ lFDI: 'SITE1', nameplateW: 5000, capacityWh: 13500, initialSoC: 50 });
    const s = g.snapshot();
    expect(s.soc).toBeGreaterThanOrEqual(0);
    expect(s.soc).toBeLessThanOrEqual(100);
    expect(typeof s.realPowerW).toBe('number');
  });

  it('discharging drains SoC over time', () => {
    const g = new SyntheticGenerator({ lFDI: 'SITE1', nameplateW: 5000, capacityWh: 13500, initialSoC: 50 });
    g.setDischargeSetpoint(3000);      // discharge 3 kW
    g.step(3600);                       // one hour
    expect(g.snapshot().soc).toBeLessThan(50);
  });
});
