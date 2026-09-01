import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { aggregatorLfdiFromCertificate } from '@fortress-csip/client-core';
import type { TestCertificate } from '../../../client-core/test/test-certificates.js';

/**
 * A configurable IEEE 2030.5 server on loopback, for exercising doctor against real TLS.
 *
 * Doctor's whole job is judging transport and trust behaviour, and none of that can be
 * proven against a mock transport — an untrusted issuer, a client presenting no certificate,
 * and a redirect all have to travel through a real socket to mean anything. So the tests
 * stand up an actual HTTPS server and vary one property at a time.
 */

const NS = 'urn:ieee:std:2030.5:ns';

export interface FixtureOptions {
  server: TestCertificate;
  /** Roots trusted for client certificates. Omit to accept anonymous clients. */
  clientTrustRoots?: Uint8Array[];
  /** LFDIs the application authorizes. A trusted client outside this list gets 403. */
  allowedLfdis?: string[];
  /** Serve a redirect instead of the resource. */
  redirectTo?: string;
  /** Serve a DeviceCapability that is not well-formed XML. */
  malformedCapability?: boolean;
  /** Serve a DeviceCapability with no namespace declaration. */
  omitNamespace?: boolean;
  /** Advertise a link on another origin. */
  crossOriginLink?: boolean;
  /** Omit these links from DeviceCapability. */
  omitLinks?: Array<'Time' | 'EndDeviceList' | 'MirrorUsagePointList'>;
  /** Advertise a non-positive pollRate. */
  invalidPollRate?: boolean;
  /** Break pagination: `all` disagrees with what is served. */
  brokenPagination?: boolean;
  /** Serve a page larger than the 500-item cap. */
  oversizedPage?: boolean;
  /** Pad the DeviceCapability response beyond the 1 MiB client byte cap. */
  oversizedBody?: boolean;
  /** Plain HTTP instead of HTTPS. */
  plainHttp?: boolean;
}

export interface RunningFixture {
  origin: string;
  port: number;
  /** Every request the server saw, as `METHOD path`. */
  requests: string[];
  close(): Promise<void>;
}

export async function startCsipFixture(options: FixtureOptions): Promise<RunningFixture> {
  const requests: string[] = [];

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const path = new URL(request.url ?? '/', 'http://fixture').pathname;
    requests.push(`${request.method} ${path}`);

    if (options.redirectTo !== undefined) {
      response.writeHead(302, { location: options.redirectTo }).end();
      return;
    }

    // Application-level authorization, decided from the verified peer certificate only —
    // never from a caller-supplied header.
    if (options.clientTrustRoots !== undefined) {
      const socket = request.socket as unknown as {
        authorized?: boolean;
        getPeerCertificate?: (detailed?: boolean) => { raw?: Buffer };
      };
      if (socket.authorized !== true) {
        response.writeHead(401).end();
        return;
      }
      const raw = socket.getPeerCertificate?.(false)?.raw;
      const lfdi = raw === undefined || raw.byteLength === 0 ? undefined : aggregatorLfdiFromCertificate(raw);
      if (options.allowedLfdis !== undefined && (lfdi === undefined || !options.allowedLfdis.includes(lfdi))) {
        response.writeHead(403).end();
        return;
      }
    }

    if (path === '/sep2/capability') {
      sendXml(response, deviceCapability(options));
      return;
    }
    if (path === '/sep2/edev') {
      sendXml(response, endDeviceList(options));
      return;
    }
    response.writeHead(404).end();
  };

  const server: Server = options.plainHttp
    ? (createHttpServer(handler) as unknown as Server)
    : createHttpsServer(
        {
          cert: Buffer.from(options.server.certificate),
          key: Buffer.from(options.server.privateKey),
          ...(options.clientTrustRoots === undefined
            ? {}
            : {
                requestCert: true,
                rejectUnauthorized: true,
                ca: options.clientTrustRoots.map((root) => Buffer.from(root)),
              }),
        },
        handler,
      );

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    port,
    origin: `${options.plainHttp ? 'http' : 'https'}://localhost:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function sendXml(response: ServerResponse, body: string): void {
  response.writeHead(200, { 'content-type': 'application/sep+xml' });
  response.end(body);
}

function deviceCapability(options: FixtureOptions): string {
  if (options.malformedCapability === true) {
    return '<DeviceCapability xmlns="urn:ieee:std:2030.5:ns"><pollRate>not closed';
  }
  const omitted = new Set(options.omitLinks ?? []);
  const namespace = options.omitNamespace === true ? '' : ` xmlns="${NS}"`;
  const pollRate = options.invalidPollRate === true ? 0 : 300;
  const links = [
    omitted.has('Time') ? '' : '<TimeLink href="/sep2/tm"/>',
    omitted.has('EndDeviceList')
      ? ''
      : `<EndDeviceListLink href="${options.crossOriginLink === true ? 'https://elsewhere.example/edev' : '/sep2/edev'}"/>`,
    omitted.has('MirrorUsagePointList') ? '' : '<MirrorUsagePointListLink href="/sep2/mup"/>',
  ].join('');
  // Padding is a comment so the document stays valid while exceeding the byte cap.
  const padding = options.oversizedBody === true ? `<!--${'x'.repeat(1_200_000)}-->` : '';
  return `<?xml version="1.0" encoding="UTF-8"?><DeviceCapability${namespace} pollRate="${pollRate}">${links}${padding}</DeviceCapability>`;
}

function endDeviceList(options: FixtureOptions): string {
  const count = options.oversizedPage === true ? 501 : 2;
  const devices = Array.from({ length: count }, (_, index) =>
    `<EndDevice href="/sep2/edev/${index}"><lFDI>${String(index).padStart(40, '0')}</lFDI></EndDevice>`,
  ).join('');
  // A mismatch between `all` and the items actually served is exactly what the pagination
  // contract forbids, and what a partner most often gets wrong.
  const all = options.brokenPagination === true ? count + 5 : count;
  return `<?xml version="1.0" encoding="UTF-8"?><EndDeviceList xmlns="${NS}" all="${all}" results="${count}">${devices}</EndDeviceList>`;
}
