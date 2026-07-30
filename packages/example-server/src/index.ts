import express from 'express';
import { fileURLToPath } from 'node:url';
import { credentials } from '@grpc/grpc-js';
import { Store } from './store.js';
import { csipRouter } from './routes.js';
import { adminRouter } from './admin.js';
import { seedBackfill } from './backfill.js';
import {
  DEFAULT_END_DEVICES,
  DEFAULT_PROGRAM_PROJECTIONS,
  ProgramProjectionCatalog,
  makeDefaultFixtureEnrollmentSource,
  type AssignmentSourceV1,
  type EndDeviceIdentity,
  type ProgramProjection,
} from './enrollment-source.js';
import {
  FortressEnrollmentSourceV1,
  makeGrpcAssignmentSnapshotRpcV1,
} from './fortress-enrollment-client.js';

/** Permissive CORS so the browser console (and partner tools) can call the admin/2030.5
 *  API and the client /status from any origin. This is a dev sandbox, not production. */
function cors(_req: express.Request, res: express.Response, next: express.NextFunction) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  next();
}

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

const enrollmentSourceFromEnvironment = (): AssignmentSourceV1 => {
  const address = process.env.FORTRESS_ENROLLMENT_ADDRESS;
  if (address == null || address === '') return makeDefaultFixtureEnrollmentSource();
  const principalId = process.env.FORTRESS_ENROLLMENT_PRINCIPAL_ID;
  const actor = process.env.FORTRESS_ENROLLMENT_ACTOR;
  const serviceToken = process.env.FORTRESS_ENROLLMENT_SERVICE_TOKEN;
  if (!principalId || !actor || !serviceToken) {
    throw new Error('Fortress enrollment client configuration is incomplete');
  }
  const allowInsecure = process.env.FORTRESS_ENROLLMENT_ALLOW_INSECURE === 'true';
  const rpc = makeGrpcAssignmentSnapshotRpcV1({
    address,
    credentials: allowInsecure ? credentials.createInsecure() : credentials.createSsl(),
  });
  return new FortressEnrollmentSourceV1(rpc, {
    principalId,
    actor,
    serviceToken,
  });
};

export interface AppOptions {
  admin?: boolean;
  console?: boolean;
  assignmentSource?: AssignmentSourceV1;
  endDevices?: EndDeviceIdentity[];
  programProjections?: ProgramProjection[];
  onProjectionError?: (error: Error) => void;
}

export function makeApp(opts: AppOptions = {}) {
  const admin = opts.admin ?? process.env.NODE_ENV !== 'production';
  const serveConsole = opts.console ?? true;
  const store = new Store(opts.endDevices ?? DEFAULT_END_DEVICES);
  const assignmentSource = opts.assignmentSource ?? enrollmentSourceFromEnvironment();
  const programCatalog = new ProgramProjectionCatalog(
    opts.programProjections ?? DEFAULT_PROGRAM_PROJECTIONS,
  );
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
  app.use(csipRouter(store, {
    assignmentSource,
    programCatalog,
    onProjectionError: opts.onProjectionError ?? ((error) => {
      console.error(`[enrollment-projection] ${error.name}`);
    }),
  }));
  return { app, store, assignmentSource };
}

if (process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.PORT ?? 7001);
  makeApp().app.listen(port, () => {
    console.log(`[example-server] on :${port}`);
    console.log(`[example-server] partner console at http://localhost:${port}/`);
  });
}
