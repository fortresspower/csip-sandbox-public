import { describe, it, expect } from 'vitest';
import { Store } from '../src/store.js';

describe('Store', () => {
  it('accepts a MirrorMeterReading and lists it back', () => {
    const s = new Store();
    s.addMeterReading('<MirrorMeterReading>...</MirrorMeterReading>');
    expect(s.meterReadings()).toHaveLength(1);
  });
  it('queues and drains DERControls', () => {
    const s = new Store();
    s.queueControl({ mRID: 'C1', opModFixedW: -3000 });
    expect(s.controls()).toHaveLength(1);
  });
  it('reset() clears meter readings, der statuses, and controls', () => {
    const s = new Store();
    s.addMeterReading('<MirrorMeterReading/>');
    s.addDerStatus('<DERStatus/>');
    s.queueControl({ mRID: 'C1', opModFixedW: -3000 });
    s.reset();
    expect(s.meterReadings()).toHaveLength(0);
    expect(s.derStatuses()).toHaveLength(0);
    expect(s.controls()).toHaveLength(0);
  });
});

it('stores readings with ts + mup and reads them windowed/paged', () => {
  const s = new Store();
  s.addReading({ ts: 1000, mup: 0, mrid: 'model101W', point: 'model101.W', uom: 38, value: -3000 });
  s.addReading({ ts: 1300, mup: 0, mrid: 'model101W', point: 'model101.W', uom: 38, value: -2000 });
  s.addReading({ ts: 1600, mup: 1, mrid: 'fortress:soh', point: 'model40101.sohBat', uom: 0, value: 98 });

  const p0 = s.readReadings({ mup: 0, start: 0, limit: 1 });
  expect(p0.all).toBe(2);
  expect(p0.items).toHaveLength(1);

  const after = s.readReadings({ mup: 0, after: 1200, start: 0, limit: 50 });
  expect(after.all).toBe(1);
  expect(after.items[0].value).toBe(-2000);

  const fortress = s.readReadings({ mup: 1, start: 0, limit: 50 });
  expect(fortress.all).toBe(1);
  expect(fortress.items[0].mrid).toBe('fortress:soh');
});

it('filters by mrid selection', () => {
  const s = new Store();
  s.addReading({ ts: 1, mup: 0, mrid: 'model101W', point: 'model101.W', uom: 38, value: 1 });
  s.addReading({ ts: 1, mup: 0, mrid: 'model101VAr', point: 'model101.VAr', uom: 63, value: 2 });
  const only = s.readReadings({ mup: 0, start: 0, limit: 50, mrids: ['model101VAr'] });
  expect(only.all).toBe(1);
  expect(only.items[0].mrid).toBe('model101VAr');
});
