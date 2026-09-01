import express, { type NextFunction, type Request, type Response } from 'express';
import { PartnerDomain } from './partner-domain.js';
import { partnerCsipRouter, type ConnectionResolver, type HttpError } from './partner-routes.js';
import type { PartnerPersistence, RetentionPolicy } from './persistence/port.js';

export interface PartnerAppOptions {
  persistence: PartnerPersistence;
  resolveConnection: ConnectionResolver;
  now?: () => number;
  retention?: RetentionPolicy;
}

export function makePartnerApp(options: PartnerAppOptions) {
  const domain = new PartnerDomain(options);
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_request, response) => response.status(200).json({ status: 'ok' }));
  app.use('/sep2', express.text({ type: ['application/sep+xml', 'application/xml'], limit: '1mb' }));
  app.use('/sep2', partnerCsipRouter(domain, options.resolveConnection));
  app.use((error: HttpError | Error, _request: Request, response: Response, _next: NextFunction) => {
    const status = 'status' in error && typeof error.status === 'number' ? error.status : 500;
    if (status >= 500) {
      const category = error.name.includes('Throttl') ? 'persistence_throttled' : 'internal';
      console.error(JSON.stringify({ event: 'csip_request_failed', category }));
    }
    response.status(status).json({ error: status >= 500 ? 'internal server error' : error.message });
  });
  return { app, domain };
}
