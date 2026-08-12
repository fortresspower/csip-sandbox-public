import { describe, it, expect } from 'vitest';
import { Uom } from '../src/uom.js';

describe('Uom', () => {
  it('has the CSIP-required + spec-optional codes', () => {
    expect(Uom.None).toBe(0);
    expect(Uom.Voltage).toBe(29);
    expect(Uom.Hz).toBe(33);
    expect(Uom.W).toBe(38);
    expect(Uom.VA).toBe(61);
    expect(Uom.var).toBe(63);
    expect(Uom.CosTheta).toBe(65);
    expect(Uom.Wh).toBe(72);
    expect(Uom.Amps).toBe(5);
  });
});
