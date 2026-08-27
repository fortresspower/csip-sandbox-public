import { promises as dns } from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import type { LookupAddress } from 'node:dns';
import {
  CsipAuthenticationError,
  CsipAuthorizationError,
  CsipCircuitOpenError,
  CsipConfigurationError,
  CsipError,
  CsipProtocolError,
  CsipResponseTooLargeError,
  CsipRetryableServerError,
  CsipTimeoutError,
  type CsipRequestOptions,
  type CsipResponse,
  type CsipTlsMaterial,
  type CsipTransport,
  type CsipTransportOptions,
  type DnsResolver,
} from './types.js';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
export const DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;
export const DEFAULT_CIRCUIT_BREAKER_RESET_TIMEOUT_MS = 30_000;
const SEP_XML = 'application/sep+xml';

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv6');
}

const defaultResolver: DnsResolver = async (hostname) =>
  (await dns.lookup(hostname, { all: true, verbatim: true }))
    .map((entry: LookupAddress) => entry.address);

function hasBytes(value: Uint8Array | undefined): value is Uint8Array {
  return value !== undefined && value.byteLength > 0;
}

function validateTls(
  tls: CsipTlsMaterial | undefined,
  environment: CsipTransportOptions['environment'],
): asserts tls is CsipTlsMaterial {
  if (!tls || !hasBytes(tls.certificate) || !hasBytes(tls.privateKey)) {
    throw new CsipConfigurationError(
      'HTTPS connections require a client certificate chain and matching private key',
    );
  }
  if (environment === 'deployed' && tls.certificateAuthorities !== undefined) {
    throw new CsipConfigurationError(
      'custom CA certificates are permitted only for explicit local-test fixtures; deployed connections use system server trust',
    );
  }
  if (
    tls.certificateAuthorities !== undefined
    && (tls.certificateAuthorities.length === 0
      || tls.certificateAuthorities.some((authority) => !hasBytes(authority)))
  ) {
    throw new CsipConfigurationError('local-test custom CA certificates must be non-empty');
  }
}

function isLoopback(address: string): boolean {
  if (isIP(address) === 4) return address.startsWith('127.');
  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mapped ? mapped.startsWith('127.') : false;
}

function isBlocked(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return blockedAddresses.check(mapped, 'ipv4');
  return blockedAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function responseHeaders(headers: http.IncomingHttpHeaders): Readonly<Record<string, string>> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) normalized[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return normalized;
}

function mapRequestError(
  error: unknown,
  method: string,
  href: string,
  secureTransport: boolean,
): CsipError {
  if (error instanceof CsipError) return error;
  const code = String((error as NodeJS.ErrnoException)?.code ?? '');
  const message = String((error as Error)?.message ?? error);
  if (
    code.startsWith('ERR_TLS')
    || code.startsWith('ERR_SSL')
    || code.startsWith('CERT_')
    || code.includes('CERT')
    || (secureTransport && code === 'ECONNRESET')
    || /certificate|tls alert|ssl/i.test(message)
  ) {
    return new CsipAuthenticationError(`${method} ${href} failed mutual TLS verification`, error);
  }
  return new CsipRetryableServerError(method, href, 0, '', error);
}

function buildHttpsAgent(tls: CsipTlsMaterial): https.Agent {
  const certificateAuthorities = tls.certificateAuthorities?.map((authority) => Buffer.from(authority));
  return new https.Agent({
    cert: Buffer.from(tls.certificate),
    key: Buffer.from(tls.privateKey),
    ...(certificateAuthorities ? { ca: certificateAuthorities } : {}),
    rejectUnauthorized: true,
    keepAlive: true,
  });
}

export function createCsipTransport(options: CsipTransportOptions): CsipTransport {
  let baseUrl: URL;
  try {
    baseUrl = new URL(options.baseUrl);
  } catch (error) {
    throw new CsipConfigurationError(`invalid CSIP base URL: ${String(error)}`);
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new CsipConfigurationError('CSIP base URL must not contain credentials, a query, or a fragment');
  }
  if (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') {
    throw new CsipConfigurationError('CSIP base URL must use HTTPS');
  }
  if (options.environment === 'deployed') {
    if (baseUrl.protocol !== 'https:') {
      throw new CsipConfigurationError('deployed CSIP connections require HTTPS with mutual TLS');
    }
    if (isIP(baseUrl.hostname) !== 0) {
      throw new CsipConfigurationError('deployed CSIP endpoints must use a DNS hostname, not an IP literal');
    }
    if (baseUrl.port && baseUrl.port !== '443') {
      throw new CsipConfigurationError('deployed CSIP endpoints must use TCP 443');
    }
  }
  if (baseUrl.protocol === 'https:') validateTls(options.tls, options.environment);
  if (baseUrl.protocol === 'http:' && options.environment !== 'local-test') {
    throw new CsipConfigurationError('plain HTTP is permitted only for explicit local-test transports');
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const circuitFailureThreshold = options.circuitBreaker?.failureThreshold
    ?? DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD;
  const circuitResetTimeoutMs = options.circuitBreaker?.resetTimeoutMs
    ?? DEFAULT_CIRCUIT_BREAKER_RESET_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new CsipConfigurationError('timeoutMs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new CsipConfigurationError('maxResponseBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(circuitFailureThreshold) || circuitFailureThreshold <= 0) {
    throw new CsipConfigurationError('circuit breaker failureThreshold must be a positive safe integer');
  }
  if (!Number.isSafeInteger(circuitResetTimeoutMs) || circuitResetTimeoutMs <= 0) {
    throw new CsipConfigurationError('circuit breaker resetTimeoutMs must be a positive safe integer');
  }

  const resolver = options.resolveDns ?? defaultResolver;
  const httpsAgent = baseUrl.protocol === 'https:' ? buildHttpsAgent(options.tls!) : undefined;
  const origin = baseUrl.origin;
  const basePath = baseUrl.pathname.replace(/\/+$/, '');
  let retryableFailures = 0;
  let circuitOpenUntil = 0;
  let halfOpenProbeInFlight = false;

  async function checkedAddress(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
    let addresses: string[];
    try {
      addresses = isIP(hostname) === 0 ? await resolver(hostname) : [hostname];
    } catch (error) {
      throw new CsipRetryableServerError('DNS', hostname, 0, '', error);
    }
    if (addresses.length === 0) throw new CsipProtocolError(`DNS returned no addresses for ${hostname}`);
    for (const address of addresses) {
      const family = isIP(address);
      if (family === 0) throw new CsipProtocolError(`DNS returned an invalid address for ${hostname}`);
      if (options.environment === 'local-test') {
        if (!isLoopback(address)) {
          throw new CsipProtocolError(`local-test endpoint ${hostname} resolved outside loopback`);
        }
      } else if (isBlocked(address)) {
        throw new CsipProtocolError(`CSIP endpoint ${hostname} resolved to a non-public address`);
      }
    }
    const selected = addresses[0];
    return { address: selected, family: isIP(selected) as 4 | 6 };
  }

  function targetUrl(href: string): URL {
    let target: URL;
    try {
      target = new URL(href, `${origin}${basePath || '/'}`);
    } catch {
      throw new CsipProtocolError(`invalid CSIP resource link: ${href}`);
    }
    if (target.origin !== origin) {
      throw new CsipProtocolError(`cross-origin CSIP link is not allowed: ${target.origin}`);
    }
    if (target.username || target.password) {
      throw new CsipProtocolError('CSIP links must not contain URL credentials');
    }
    return target;
  }

  async function requestOnce(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    href: string,
    requestOptions: CsipRequestOptions = {},
  ): Promise<CsipResponse> {
    const target = targetUrl(href);
    const resolved = await checkedAddress(target.hostname);
    const headers: Record<string, string> = {
      accept: SEP_XML,
      ...requestOptions.headers,
    };
    if (requestOptions.body !== undefined) {
      headers['content-type'] ??= SEP_XML;
      headers['content-length'] = String(Buffer.byteLength(requestOptions.body));
    }

    return new Promise<CsipResponse>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        callback();
      };
      const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all) {
          callback(null, [{ address: resolved.address, family: resolved.family }]);
        } else {
          callback(null, resolved.address, resolved.family);
        }
      };
      const requestFn = target.protocol === 'https:' ? https.request : http.request;
      const req = requestFn(target, {
        method,
        headers,
        timeout: timeoutMs,
        lookup,
        ...(httpsAgent ? { agent: httpsAgent } : {}),
      }, (response) => {
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        response.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.byteLength;
          if (receivedBytes > maxResponseBytes) {
            const error = new CsipResponseTooLargeError(method, target.href, maxResponseBytes);
            finish(() => reject(error));
            response.destroy();
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const status = response.statusCode ?? 0;
          const headersOut = responseHeaders(response.headers);
          finish(() => {
            if (status >= 300 && status < 400 && status !== 304) {
              reject(new CsipProtocolError(
                `redirects are not allowed for CSIP requests${headersOut.location ? `: ${headersOut.location}` : ''}`,
                status,
                body,
              ));
            } else if (status === 401 || status === 403) {
              reject(new CsipAuthorizationError(method, target.href, status, body));
            } else if (status === 408) {
              reject(new CsipTimeoutError(method, target.href, timeoutMs));
            } else if (status === 429 || status >= 500) {
              reject(new CsipRetryableServerError(method, target.href, status, body));
            } else if (status >= 400) {
              reject(new CsipProtocolError(`${method} ${target.href} failed with status ${status}`, status, body));
            } else {
              resolve({ status, headers: headersOut, body });
            }
          });
        });
        response.on('error', (error) => finish(() => reject(
          mapRequestError(error, method, target.href, target.protocol === 'https:'),
        )));
      });
      const deadline = setTimeout(
        () => req.destroy(new CsipTimeoutError(method, target.href, timeoutMs)),
        timeoutMs,
      );
      req.on('timeout', () => req.destroy(new CsipTimeoutError(method, target.href, timeoutMs)));
      req.on('error', (error) => finish(() => reject(
        mapRequestError(error, method, target.href, target.protocol === 'https:'),
      )));
      if (requestOptions.body !== undefined) req.write(requestOptions.body);
      req.end();
    });
  }

  async function request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    href: string,
    requestOptions: CsipRequestOptions = {},
  ): Promise<CsipResponse> {
    const now = Date.now();
    if (circuitOpenUntil > now) {
      throw new CsipCircuitOpenError(circuitOpenUntil - now);
    }
    const isHalfOpenProbe = circuitOpenUntil !== 0;
    if (isHalfOpenProbe && halfOpenProbeInFlight) {
      throw new CsipCircuitOpenError(0);
    }
    if (isHalfOpenProbe) halfOpenProbeInFlight = true;
    try {
      const response = await requestOnce(method, href, requestOptions);
      retryableFailures = 0;
      circuitOpenUntil = 0;
      return response;
    } catch (error) {
      if (error instanceof CsipError && error.retryable) {
        retryableFailures += 1;
        if (retryableFailures >= circuitFailureThreshold) {
          circuitOpenUntil = Date.now() + circuitResetTimeoutMs;
        }
      }
      throw error;
    } finally {
      if (isHalfOpenProbe) halfOpenProbeInFlight = false;
    }
  }

  return {
    origin,
    request,
    get: (href) => request('GET', href),
    post: (href, body) => request('POST', href, { body }),
    put: (href, body) => request('PUT', href, { body }),
    close: () => httpsAgent?.destroy(),
  };
}
