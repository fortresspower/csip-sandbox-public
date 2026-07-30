import { describe, it, expect } from 'vitest';
import type {
  DERControl,
  DERProgram,
  EndDevice,
  FunctionSetAssignments,
  MirrorMeterReading,
} from '../src/resources.js';
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

  it('models the EndDevice to FSA to DERProgram assignment graph', () => {
    const endDevice: EndDevice = {
      href: '/edev/0',
      lFDI: '00112233445566778899AABBCCDDEEFF00112233',
      sFDI: '111111111111',
      changedTime: 1514836800,
      enabled: true,
      FunctionSetAssignmentsListLink: { href: '/edev/0/fsa', all: 1 },
    };
    const assignments: FunctionSetAssignments = {
      href: '/edev/0/fsa/0',
      mRID: '00112233445566778899AABBCCDDEEFF',
      DERProgramListLink: { href: '/edev/0/fsa/0/derp', all: 1 },
      TimeLink: { href: '/tm' },
    };
    const program: DERProgram = {
      href: '/derp/0',
      mRID: 'AABBCCDDEEFF00112233445566778899',
      primacy: 0,
      DERControlListLink: { href: '/derp/0/derc' },
    };

    expect(endDevice.FunctionSetAssignmentsListLink.all).toBe(1);
    expect(assignments.DERProgramListLink.all).toBe(1);
    expect(assignments.TimeLink.href).toBe('/tm');
    expect(program.DERControlListLink.href).toBe('/derp/0/derc');
  });
});
