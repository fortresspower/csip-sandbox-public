import * as http from 'node:http';
import * as https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { PeerCertificate } from 'node:tls';
import { DEFAULT_MAX_RESPONSE_BYTES } from '@fortress-csip/client-core';

/**
 * A single bounded request made *without* a client certificate.
 *
 * client-core's transport cannot do this: it requires a client certificate and key by design,
 * which is exactly the property that makes it safe. But proving a server *enforces* mutual TLS
 * requires attempting a connection that has no identity at all, so this probe exists.
 *
 * It is deliberately narrow. It performs one request, follows nothing, reads a bounded number
 * of bytes, gives up on a deadline, and pins the connection to `address`.
 *
 * That address MUST be one the caller resolved and validated in a single step — the entries of
 * `ParsedOrigin.addresses`, never a fresh lookup. Resolving again here, or in the caller, would
 * reopen the gap this pinning exists to close: an authoritative server can answer differently
 * on a second query, so the address connected to would not be the address approved.
 */

export interface ProbeOptions {
  url: URL;
  /**
   * An address from `ParsedOrigin.addresses` — resolved and validated in one step by the
   * origin checks. The probe performs no lookup of its own.
   */
  address: string;
  /** Extra roots, permitted only in --local mode. */
  certificateAuthorities?: Uint8Array[];
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export type ProbeOutcome =
  | {
      kind: 'response';
      status: number;
      /** Only the headers doctor reasons about, never the full set. */
      location?: string;
      contentType?: string;
      bodyBytes: number;
      /** True when the response body exceeded the byte cap and was cut off. */
      truncated: boolean;
      certificate?: ProbedCertificate;
    }
  | { kind: 'tls-rejected'; detail: string; certificate?: ProbedCertificate }
  | { kind: 'network-error'; code: string; detail: string }
  | { kind: 'timeout' };

/** Server certificate facts doctor reports. No PEM body, no extensions dump. */
export interface ProbedCertificate {
  subjectCommonName?: string;
  subjectAltNames: string[];
  issuerCommonName?: string;
  validFrom?: string;
  validTo?: string;
  /** Whether Node's own verification, against the trust store in use, accepted it. */
  authorized: boolean;
  authorizationError?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
// The same cap client-core applies. A lower one here would report a response as oversized
// that Fortress would in fact accept, which is worse than not checking at all.
const DEFAULT_MAX_BYTES = DEFAULT_MAX_RESPONSE_BYTES;

export async function probeAnonymously(options: ProbeOptions): Promise<ProbeOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_BYTES;
  const secure = options.url.protocol === 'https:';

  // Pin to the vetted address: resolving again here would let a DNS answer differ between the
  // address the origin checks approved and the address actually connected to.
  const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
    const family = isIP(options.address) as 4 | 6;
    if (lookupOptions.all) callback(null, [{ address: options.address, family }]);
    else callback(null, options.address, family);
  };

  return new Promise<ProbeOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      request.destroy();
      resolve(outcome);
    };

    const requestFn = secure ? https.request : http.request;
    const request = requestFn(
      options.url,
      {
        method: 'GET',
        headers: { accept: 'application/sep+xml' },
        lookup,
        timeout: timeoutMs,
        ...(secure
          ? {
              rejectUnauthorized: true,
              ...(options.certificateAuthorities === undefined
                ? {}
                : { ca: options.certificateAuthorities.map((ca) => Buffer.from(ca)) }),
              // Deliberately no cert/key: the point of this probe is to have no identity.
              servername: options.url.hostname,
            }
          : {}),
      },
      (response) => {
        const certificate = secure ? describeSocket(request) : undefined;
        let bodyBytes = 0;
        let truncated = false;
        response.on('data', (chunk: Buffer) => {
          bodyBytes += chunk.byteLength;
          if (bodyBytes > maxBytes) {
            truncated = true;
            response.destroy();
          }
        });
        const complete = () =>
          finish({
            kind: 'response',
            status: response.statusCode ?? 0,
            location: headerValue(response.headers.location),
            contentType: headerValue(response.headers['content-type']),
            bodyBytes,
            truncated,
            certificate,
          });
        response.on('end', complete);
        response.on('close', complete);
        response.on('error', complete);
      },
    );

    const deadline = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    request.on('timeout', () => finish({ kind: 'timeout' }));
    request.on('error', (error: NodeJS.ErrnoException) => {
      const code = String(error.code ?? '');
      const message = String(error.message ?? '');
      if (isTlsRejection(code, message, secure)) {
        finish({ kind: 'tls-rejected', detail: message, certificate: describeSocket(request) });
        return;
      }
      finish({ kind: 'network-error', code: code || 'UNKNOWN', detail: message });
    });
    request.end();
  });
}

/**
 * Did the peer refuse the handshake, as opposed to failing to connect?
 *
 * Mirrors client-core's classification: a terminator that rejects an unauthenticated client
 * commonly resets the connection rather than sending an alert, so on a secure socket a reset
 * counts as a rejection. Getting this wrong would report an enforcing server as unreachable.
 */
function isTlsRejection(code: string, message: string, secure: boolean): boolean {
  return (
    code.startsWith('ERR_TLS') ||
    code.startsWith('ERR_SSL') ||
    code.startsWith('CERT_') ||
    code.includes('CERT') ||
    (secure && (code === 'ECONNRESET' || code === 'EPROTO')) ||
    /certificate|tls alert|ssl|handshake/i.test(message)
  );
}

function describeSocket(request: http.ClientRequest): ProbedCertificate | undefined {
  const socket = request.socket as unknown as {
    getPeerCertificate?: (detailed?: boolean) => PeerCertificate;
    authorized?: boolean;
    authorizationError?: Error | string;
  } | null;
  if (socket?.getPeerCertificate === undefined) return undefined;

  let peer: PeerCertificate;
  try {
    peer = socket.getPeerCertificate(false);
  } catch {
    return undefined;
  }
  if (peer === undefined || Object.keys(peer).length === 0) return undefined;

  return {
    subjectCommonName: firstCommonName(peer.subject?.CN),
    subjectAltNames: parseSubjectAltNames(peer.subjectaltname),
    issuerCommonName: firstCommonName(peer.issuer?.CN),
    validFrom: peer.valid_from,
    validTo: peer.valid_to,
    authorized: socket.authorized === true,
    authorizationError:
      socket.authorizationError === undefined
        ? undefined
        : String(socket.authorizationError),
  };
}

/** A distinguished name may carry several CNs; the report shows the first. */
function firstCommonName(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function parseSubjectAltNames(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('DNS:') || entry.startsWith('IP Address:'))
    .map((entry) => entry.slice(entry.indexOf(':') + 1).trim());
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const single = Array.isArray(value) ? value[0] : value;
  // Bounded: a header is attacker-influenced text that ends up in a report.
  return single.slice(0, 300);
}
