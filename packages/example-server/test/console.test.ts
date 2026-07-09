import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { makeApp } from '../src/index.js';

describe('partner console (static + CORS)', () => {
  it('serves the console index at / with permissive CORS', async () => {
    const { app } = makeApp();
    const r = await request(app).get('/');
    expect(r.status).toBe(200);
    expect(r.text).toContain('Fortress CSIP Sandbox Console');
    expect(r.headers['access-control-allow-origin']).toBe('*');
  });

  it('serves the console JS assets', async () => {
    const { app } = makeApp();
    const r = await request(app).get('/console/data.js');
    expect(r.status).toBe(200);
    expect(r.text).toContain('window.FP');
  });

  it('still serves the 2030.5 API alongside the console', async () => {
    const { app } = makeApp();
    const r = await request(app).get('/dcap');
    expect(r.status).toBe(200);
    expect(r.text).toContain('urn:ieee:std:2030.5:ns');
  });

  it('answers a CORS preflight with 204', async () => {
    const { app } = makeApp();
    const r = await request(app).options('/test/dercontrol');
    expect(r.status).toBe(204);
    expect(r.headers['access-control-allow-methods']).toContain('POST');
  });

  it('can be disabled with { console: false }', async () => {
    const { app } = makeApp({ console: false });
    const r = await request(app).get('/');
    expect(r.status).toBe(404);
  });

  it('serves an OpenAPI spec describing the API', async () => {
    const { app } = makeApp();
    const r = await request(app).get('/openapi.json');
    expect(r.status).toBe(200);
    const spec = JSON.parse(r.text);
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.paths['/test/dercontrol']).toBeDefined();
    expect(spec.paths['/derp/0/derc']).toBeDefined();
  });

  it('serves Swagger UI at /docs.html and redirects /docs to it', async () => {
    const { app } = makeApp();
    const html = await request(app).get('/docs.html');
    expect(html.status).toBe(200);
    expect(html.text).toContain('swagger-ui');
    const redir = await request(app).get('/docs');
    expect(redir.status).toBe(302);
    expect(redir.headers.location).toBe('/docs.html');
  });
});
