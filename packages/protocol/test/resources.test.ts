import { describe, it, expect } from 'vitest';
import type { DERControl, EndDevice, Sep2List } from '../src/resources.js';
import { isStorageDERStatus } from '../src/resources.js';

describe('resources', () => {
  it('constructs a DERControl with v1 control modes', () => {
    const c: DERControl = {
      mRID: 'ABC123',
      responseRequired: '00',
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

  it('represents discovered EndDevices without assuming numeric paths', () => {
    const page: Sep2List<EndDevice> = {
      all: 2,
      results: 1,
      pollRate: 45,
      nextHref: '/partner/end-devices-v2?s=1',
      items: [{
        href: '/partner/end-devices-v2/device-alpha-alpha',
        lFDI: '0123456789abcdef0123456789abcdef01234567',
        FunctionSetAssignmentsListLink: '/assignments/summer-a',
        DERListLink: '/devices/device-alpha-alpha/ders',
      }],
    };

    expect(page.items[0].FunctionSetAssignmentsListLink).toBe('/assignments/summer-a');
    expect(page.nextHref).toBe('/partner/end-devices-v2?s=1');
  });
});
