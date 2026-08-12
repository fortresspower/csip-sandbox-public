import { createHash, X509Certificate } from 'node:crypto';
import type { Request } from 'express';
import type { ConnectionResolver } from './partner-routes.js';
import type { PartnerPersistence } from './persistence/port.js';

export const ALB_CLIENT_CERTIFICATE_LEAF_HEADER = 'x-amzn-mtls-clientcert-leaf';
const MAX_CERTIFICATE_HEADER_BYTES = 64 * 1024;

export function verifiedLeafConnectionResolver(persistence: PartnerPersistence): ConnectionResolver {
  return async (request: Request): Promise<string | undefined> => {
    const raw = request.headers[ALB_CLIENT_CERTIFICATE_LEAF_HEADER];
    if (raw === undefined) return undefined;
    if (Array.isArray(raw) || Buffer.byteLength(raw, 'utf8') > MAX_CERTIFICATE_HEADER_BYTES) {
      throw authorizationError(401, 'invalid verified client certificate header');
    }
    let aggregatorLfdi: string;
    try {
      aggregatorLfdi = aggregatorLfdiFromAlbLeafHeader(raw);
    } catch {
      console.warn(JSON.stringify({ event: 'csip_auth_rejected', reason: 'invalid_leaf_header' }));
      throw authorizationError(401, 'invalid verified client certificate header');
    }
    const connection = await persistence.findConnectionByAggregatorLfdi(aggregatorLfdi);
    if (!connection) {
      console.warn(JSON.stringify({ event: 'csip_auth_rejected', reason: 'not_allowlisted' }));
      throw authorizationError(403, 'client certificate is not authorized');
    }
    return connection.connectionId;
  };
}

export function aggregatorLfdiFromAlbLeafHeader(header: string): string {
  const pem = decodeURIComponent(header).replaceAll('\r\n', '\n');
  if (!/^-----BEGIN CERTIFICATE-----\n(?:[A-Za-z0-9+/=]+\n)+-----END CERTIFICATE-----\n?$/.test(pem)) {
    throw new Error('leaf header must contain exactly one PEM certificate');
  }
  const certificate = new X509Certificate(pem);
  if (certificate.ca) throw new Error('leaf header must not contain a CA certificate');
  return createHash('sha256').update(certificate.raw).digest('hex').slice(0, 40);
}

function authorizationError(status: 401 | 403, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}
