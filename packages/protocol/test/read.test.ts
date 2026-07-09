import { describe, it, expect } from 'vitest';
import { buildReadUrl, parseReadQuery } from '../src/read-url.js';
import { serializeMirrorMeterReadingListPage, parseMirrorMeterReadingList } from '../src/xml.js';
import { Uom } from '../src/uom.js';

describe('read-url', () => {
  it('builds a latest-only URL (s=0,l=1)', () => {
    expect(buildReadUrl({ mup: 0, start: 0, limit: 1 })).toBe('/mup/0/mr?s=0&l=1');
  });
  it('builds an after-time history URL with start paging', () => {
    expect(buildReadUrl({ mup: 1, after: 1780419851, start: 50, limit: 50 }))
      .toBe('/mup/1/mr?a=1780419851&s=50&l=50');
  });
  it('appends repeated mrid selectors', () => {
    expect(buildReadUrl({ mup: 0, start: 0, limit: 50, mrids: ['model101W', 'fortress:soh'] }))
      .toBe('/mup/0/mr?s=0&l=50&mrid=model101W&mrid=fortress%3Asoh');
  });
  it('parses a query back into a normalized read request', () => {
    expect(parseReadQuery({ a: '1780419851', s: '50', l: '50', mrid: ['x', 'y'] }))
      .toEqual({ after: 1780419851, start: 50, limit: 50, mrids: ['x', 'y'] });
  });
  it('defaults start=0, limit=50 when absent', () => {
    expect(parseReadQuery({})).toEqual({ after: undefined, start: 0, limit: 50, mrids: undefined });
  });
  it('clamps NaN s and l to defaults', () => {
    expect(parseReadQuery({ s: 'bad', l: 'bad' }))
      .toEqual({ after: undefined, start: 0, limit: 50, mrids: undefined });
  });
});

const oneReading = (mrid: string, value: number, start: number) => ({
  mRID: mrid, description: mrid,
  ReadingType: { uom: Uom.W, mRID: mrid, powerOfTenMultiplier: 0 },
  Reading: { timePeriod: { start, duration: 0 }, value },
});

describe('read-list xml', () => {
  it('serializes a page with all/results and a next-page Link', () => {
    const xml = serializeMirrorMeterReadingListPage({
      items: [oneReading('fortress:soh', 98, 1000)], all: 540, results: 1,
      nextHref: '/mup/1/mr?a=1000&s=1&l=1',
    });
    expect(xml).toContain('all="540"');
    expect(xml).toContain('results="1"');
    expect(xml).toContain('rel="next"');
    expect(xml).toContain('href="/mup/1/mr?a=1000&amp;s=1&amp;l=1"');
  });
  it('omits the Link at the tail (no next page)', () => {
    const xml = serializeMirrorMeterReadingListPage({ items: [oneReading('x', 1, 1)], all: 1, results: 1 });
    expect(xml).not.toContain('rel="next"');
  });
  it('round-trips a page back into readings + paging', () => {
    const xml = serializeMirrorMeterReadingListPage({
      items: [oneReading('model101W', -3000, 1000), oneReading('model101W', -2000, 1300)],
      all: 2, results: 2,
    });
    const page = parseMirrorMeterReadingList(xml);
    expect(page.all).toBe(2);
    expect(page.readings).toHaveLength(2);
    expect(page.readings[1].value).toBe(-2000);
    expect(page.readings[0].mRID).toBe('model101W');
  });
  it('round-trips nextHref (& unescaped) through parse', () => {
    const xml = serializeMirrorMeterReadingListPage({
      items: [oneReading('x', 1, 1)], all: 5, results: 1, nextHref: '/mup/1/mr?a=1000&s=1&l=1',
    });
    const page = parseMirrorMeterReadingList(xml);
    expect(page.nextHref).toBe('/mup/1/mr?a=1000&s=1&l=1');
  });
});
