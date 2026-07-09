import { describe, it, expect } from 'vitest';
import type { DERControl, MirrorMeterReading } from '../src/resources.js';
import { isStorageDERStatus } from '../src/resources.js';

describe('resources', () => {
  it('constructs a DERControl with v1 control modes', () => {
    const c: DERControl = {
      mRID: 'ABC123',
      creationTime: 1000,
      EventStatus: { currentStatus: 1 },
      interval: { start: 2000, duration: 600 },
      DERControlBase: { opModConnect: false, opModMaxLimW: 5000, opModFixedW: -3000 },
    };
    expect(c.DERControlBase.opModConnect).toBe(false);
  });

  it('detects storage DERStatus by presence of stateOfChargeStatus', () => {
    expect(isStorageDERStatus({ readingTime: 1, stateOfChargeStatus: { value: 55 } })).toBe(true);
    expect(isStorageDERStatus({ readingTime: 1 })).toBe(false);
  });
});
