import express from 'express';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { csipRouter } from './routes.js';
import { adminRouter } from './admin.js';
import { seedBackfill } from './backfill.js';

/** Permissive CORS so the browser console (and partner tools) can call the admin/2030.5
 *  API and the client /status from any origin. This is a dev sandbox, not production. */
function cors(_req: express.Request, res: express.Response, next: express.NextFunction) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  next();
}

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

export function makeApp(opts: { admin?: boolean; console?: boolean } = {}) {
  const admin = opts.admin ?? process.env.NODE_ENV !== 'production';
  const serveConsole = opts.console ?? true;
  const store = new Store();
  seedBackfill(store, { now: Math.floor(Date.now() / 1000) });
  const app = express();
  app.use(cors);
  app.options('*', (_req, res) => res.status(204).end());   // CORS preflight
  app.use(express.text({ type: ['application/sep+xml', 'application/xml', 'text/*'] }));
  app.use(express.json());
  // Static partner console at GET / (falls through to the API routes for non-file paths).
  // no-cache so edits to the console always reach the browser on a normal refresh.
  if (serveConsole) {
    app.get('/docs', (_req, res) => res.redirect('/docs.html'));   // Swagger UI (OpenAPI at /openapi.json)
    app.use(express.static(PUBLIC_DIR, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
  }
  if (admin) app.use(adminRouter(store));
  app.use(csipRouter(store));
  return { app, store };
}

if (process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.PORT ?? 7001);
  makeApp().app.listen(port, () => {
    console.log(`[example-server] on :${port}`);
    console.log(`[example-server] partner console at http://localhost:${port}/`);
  });
}
