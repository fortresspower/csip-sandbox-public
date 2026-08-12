import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createCsipTransport, type CsipTransport } from '../src/index.js';

export const xml = (root: string, content: string, attributes = ''): string =>
  `<?xml version="1.0" encoding="UTF-8"?><${root} xmlns="urn:ieee:std:2030.5:ns"${attributes}>${content}</${root}>`;

export const link = (name: string, href: string): string => `<${name} href="${href}"/>`;

export async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export interface RunningFixture {
  prefix: string;
  transport: CsipTransport;
  close(): Promise<void>;
}

export async function startFixture(handler: http.RequestListener): Promise<RunningFixture> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const prefix = `/r-${randomBytes(6).toString('hex')}`;
  const transport = createCsipTransport({
    baseUrl: `http://localhost:${port}`,
    environment: 'local-test',
    resolveDns: async () => ['127.0.0.1'],
    timeoutMs: 1_000,
  });
  return {
    prefix,
    transport,
    close: async () => {
      transport.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
