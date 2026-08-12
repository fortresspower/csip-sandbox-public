import { createHash } from 'node:crypto';
import type { PeerCertificate } from 'node:tls';
import type { Request } from 'express';
import type { ConnectionResolver } from './partner-routes.js';
import type { PartnerPersistence } from './persistence/port.js';

interface PeerCertificateSocket {
  encrypted: boolean;
  authorized: boolean;
  getPeerCertificate(detailed?: false): PeerCertificate;
}

/**
 * Resolve a locally terminated mTLS connection from the peer certificate Node verified.
 *
 * Production uses the ALB verify-mode header resolver. This direct resolver exists only for
 * loopback rehearsals where Node itself is the TLS terminator; it preserves the same LFDI allowlist
 * decision without accepting a caller-supplied identity header.
 */
export function directMtlsConnectionResolver(persistence: PartnerPersistence): ConnectionResolver {
  return async (request: Request): Promise<string | undefined> => {
    const socket = request.socket as unknown as PeerCertificateSocket;
    if (!socket.encrypted || !socket.authorized) return undefined;
    const raw = socket.getPeerCertificate(false).raw;
    if (!raw || raw.byteLength === 0) return undefined;
    const aggregatorLfdi = createHash('sha256').update(raw).digest('hex').slice(0, 40);
    return (await persistence.findConnectionByAggregatorLfdi(aggregatorLfdi))?.connectionId;
  };
}
