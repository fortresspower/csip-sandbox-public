import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  FixtureEnrollmentSourceV1,
  type AssignmentSourceV1,
} from '../src/enrollment-source.js';
import { makeApp } from '../src/index.js';

describe('IEEE 2030.5 enrollment projection', () => {
  it('walks DeviceCapability through EndDevice and FSA to paged DERPrograms', async () => {
    const { app } = makeApp({ console: false });

    const dcap = await request(app).get('/dcap');
    expect(dcap.text).toContain('<EndDeviceListLink href="/edev" all="1"/>');

    const endDevices = await request(app).get('/edev?s=0&l=1');
    expect(endDevices.status).toBe(200);
    expect(endDevices.text).toContain('all="1" results="1" pollRate="30"');
    expect(endDevices.text).toContain('href="/edev"');
    expect(endDevices.text).toContain('href="/edev/0"');

    const endDevice = await request(app).get('/edev/0');
    expect(endDevice.text).toContain('<FunctionSetAssignmentsListLink href="/edev/0/fsa" all="1"/>');
    const identity = endDevice.text.match(/<lFDI>([^<]+)<\/lFDI>/)?.[1];

    const fsaList = await request(app).get('/edev/0/fsa');
    expect(fsaList.text).toContain('href="/edev/0/fsa/0"');
    const fsa = await request(app).get('/edev/0/fsa/0');
    expect(fsa.text).toContain('<DERProgramListLink href="/edev/0/fsa/0/derp" all="2"/>');
    expect(fsa.text).toContain('<TimeLink href="/tm"/>');

    const firstPrograms = await request(app).get('/edev/0/fsa/0/derp?s=0&l=1');
    expect(firstPrograms.text).toContain('all="2" results="1" pollRate="30"');
    expect(firstPrograms.text).toContain('href="/derp/0"');
    expect(firstPrograms.text).toContain('rel="next"');
    expect(firstPrograms.text).toContain('s=1');
    const secondPrograms = await request(app).get('/edev/0/fsa/0/derp?s=1&l=1');
    expect(secondPrograms.text).toContain('href="/derp/1"');
    expect(secondPrograms.text).not.toContain('rel="next"');

    const program = await request(app).get('/derp/0');
    expect(program.text).toContain('<DERControlListLink href="/derp/0/derc"/>');
    expect(program.text).toContain('<primacy>0</primacy>');
    expect((await request(app).get('/edev/0')).text).toContain(`<lFDI>${identity}</lFDI>`);
  });

  it('adds and removes assignments without changing EndDevice identity', async () => {
    const source = new FixtureEnrollmentSourceV1({
      '1001': ['fortress-program-1'],
    });
    const { app } = makeApp({ console: false, assignmentSource: source });
    const before = await request(app).get('/edev/0');

    expect((await request(app).get('/edev/0/fsa/0/derp')).text).toContain('all="1"');
    source.setProgramProjectionKeys('1001', []);
    const inactive = await request(app).get('/edev/0/fsa/0/derp');
    expect(inactive.text).toContain('all="0" results="0"');
    expect(inactive.text).not.toContain('<DERProgram ');

    source.setProgramProjectionKeys('1001', ['fortress-program-2']);
    expect((await request(app).get('/edev/0/fsa/0/derp')).text).toContain('href="/derp/1"');
    expect((await request(app).get('/edev/0')).text).toBe(before.text);
  });

  it('returns stable empty pages and 404s for unknown identity resources', async () => {
    const { app } = makeApp({ console: false });
    const emptyPage = await request(app).get('/edev?s=9&l=1');
    expect(emptyPage.text).toContain('all="1" results="0"');
    expect(emptyPage.text).not.toContain('rel="next"');
    expect((await request(app).get('/edev/missing')).status).toBe(404);
    expect((await request(app).get('/derp/missing')).status).toBe(404);
  });

  it.each([
    ['post', '/edev'],
    ['put', '/edev/0'],
    ['post', '/edev/0/fsa'],
    ['put', '/edev/0/fsa/0'],
    ['post', '/edev/0/fsa/0/derp'],
    ['put', '/derp/0'],
  ] as const)('rejects assignment write %s %s', async (method, path) => {
    const { app } = makeApp({ console: false });
    const response = await request(app)[method](path)
      .set('Content-Type', 'application/sep+xml')
      .send('<Assignment/>');
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe('GET');
  });

  it('fails the whole assignment read on an unknown Fortress projection key', async () => {
    const onProjectionError = vi.fn();
    const source: AssignmentSourceV1 = {
      async getAssignmentSnapshot(siteId) {
        return {
          siteId,
          snapshotVersion: 'version-1',
          asOf: '2026-07-30T16:00:00.000Z',
          programProjectionKeys: ['unknown-program'],
        };
      },
    };
    const { app } = makeApp({
      console: false,
      assignmentSource: source,
      onProjectionError,
    });

    const response = await request(app).get('/edev/0/fsa/0/derp');
    expect(response.status).toBe(503);
    expect(response.text).not.toContain('<DERProgram ');
    expect(onProjectionError).toHaveBeenCalledOnce();
  });
});
