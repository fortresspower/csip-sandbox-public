import { BlockList, isIP } from 'node:net';
import type { HostResolver } from '../adapters/dns.js';
import type { ReportBuilder } from '../report/report.js';
import type { TargetMode } from '../report/types.js';

/**
 * Origin checks: is this address one a deployed Fortress client would agree to talk to?
 *
 * These mirror the rules client-core's transport enforces by throwing. Doctor cannot simply
 * let the transport throw, because a diagnostic has to report *which* rule failed and what to
 * do about it — a partner who sees "connection refused" learns nothing, and one who sees
 * "deployed endpoints must use TCP 443" fixes it in a minute.
 */

/** Address ranges a deployed partner endpoint must never resolve to. Mirrors the transport. */
const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv6');
}

export function isLoopbackAddress(address: string): boolean {
  if (isIP(address) === 4) return address.startsWith('127.');
  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
  return mapped === undefined ? false : mapped.startsWith('127.');
}

export function isNonPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address.toLowerCase())?.[1];
  if (mapped !== undefined) return NON_PUBLIC.check(mapped, 'ipv4');
  return NON_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * The origin as it is safe to record.
 *
 * The report names the target the partner supplied, but a mistyped origin can carry
 * `user:password@`, and the report is a document the partner emails to Fortress. `URL.origin`
 * drops credentials, path, query, and fragment; the fallback covers a string too malformed to
 * parse at all.
 */
export function redactOrigin(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return raw.replace(/\/\/[^/@\s]*@/, '//[redacted]@').slice(0, 200);
  }
}

export interface ParsedOrigin {
  url: URL;
  hostname: string;
  port: number;
  /**
   * The addresses that were resolved AND validated, in resolution order.
   *
   * Callers must connect to one of these rather than resolving the hostname again. A second
   * lookup can legitimately return a different answer, and an authoritative server under the
   * control of whoever is being diagnosed can make it do so on purpose — so re-resolving
   * would connect to an address these checks never approved. client-core's transport avoids
   * the same trap by resolving once and pinning from that call.
   */
  addresses: string[];
}

/**
 * Parse and check the origin, recording `origin.*` checks.
 *
 * Returns undefined when the origin is unusable, so the caller stops rather than producing a
 * cascade of confusing downstream failures against an address it could never reach.
 */
export async function checkOrigin(
  raw: string,
  mode: TargetMode,
  report: ReportBuilder,
  resolveHost: HostResolver,
): Promise<ParsedOrigin | undefined> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    report.fail('origin.valid', `"${raw}" is not a URL`, 'Pass an origin such as https://csip.partner.example.');
    return undefined;
  }
  if (url.username !== '' || url.password !== '') {
    report.fail(
      'origin.valid',
      'the origin carries URL credentials',
      'Remove the user:password prefix. CSIP authenticates with a client certificate, never with URL credentials.',
    );
    return undefined;
  }
  if (url.search !== '' || url.hash !== '') {
    report.fail(
      'origin.valid',
      'the origin carries a query string or fragment',
      'Pass the bare origin, for example https://csip.partner.example.',
    );
    return undefined;
  }
  report.pass('origin.valid', `parsed origin ${url.origin}`);

  if (url.protocol === 'https:') {
    report.pass('origin.https', 'HTTPS origin');
  } else if (mode === 'local' && url.protocol === 'http:') {
    report.warn(
      'origin.https',
      'plain HTTP, accepted only because --local was requested',
      'A deployed connection must be HTTPS. This is a loopback rehearsal only.',
    );
  } else {
    report.fail(
      'origin.https',
      `the origin uses ${url.protocol.replace(':', '')}`,
      'Fortress connects only over HTTPS. Serve the CSIP routes on https.',
    );
    return undefined;
  }

  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (mode === 'deployed') {
    if (port === 443) {
      report.pass('origin.port-443', 'TCP 443');
    } else {
      report.fail(
        'origin.port-443',
        `the origin uses TCP ${port}`,
        'Deployed connections must be reachable on TCP 443. Use --local only for a loopback rehearsal.',
      );
    }
  } else {
    report.skip('origin.port-443', `local mode: TCP ${port} accepted`);
  }

  const addresses = await checkDns(url, mode, port, report, resolveHost);
  return { url, hostname: url.hostname, port, addresses: addresses ?? [] };
}

/** Resolve once and validate every answer. Returns the approved addresses, or undefined. */
async function checkDns(
  url: URL,
  mode: TargetMode,
  port: number,
  report: ReportBuilder,
  resolveHost: HostResolver,
): Promise<string[] | undefined> {
  if (mode === 'deployed' && isIP(url.hostname) !== 0) {
    report.fail(
      'origin.public-dns',
      'the origin is an IP literal',
      'Use a public DNS hostname. The server certificate must validate for that name.',
    );
    return undefined;
  }

  let addresses: string[];
  try {
    addresses = isIP(url.hostname) === 0 ? await resolveHost(url.hostname) : [url.hostname];
  } catch (error) {
    report.fail(
      'origin.public-dns',
      `${url.hostname} did not resolve (${(error as { code?: string }).code ?? 'lookup failed'})`,
      'Publish a public DNS record for this name before a deployed connection is attempted.',
    );
    return undefined;
  }
  if (addresses.length === 0) {
    report.fail('origin.public-dns', `${url.hostname} resolved to no addresses`, 'Publish an A or AAAA record for this name.');
    return undefined;
  }

  if (mode === 'local') {
    // The mirror image of the deployed rule: --local exists to permit a custom CA and a
    // non-443 port, and both are only safe against a host that cannot be anything but this
    // machine. A name that resolves off-box would silently widen that permission.
    const offBox = addresses.filter((address) => !isLoopbackAddress(address));
    if (offBox.length > 0) {
      report.fail(
        'origin.public-dns',
        `--local was requested but ${url.hostname} resolves outside loopback`,
        'Use localhost or 127.0.0.1 for a local rehearsal, or drop --local and test the deployed origin.',
      );
      return undefined;
    }
    report.pass('origin.public-dns', `${url.hostname} resolves to loopback (${addresses.length} address(es))`);
    return addresses;
  }

  const nonPublic = addresses.filter(isNonPublicAddress);
  if (nonPublic.length > 0) {
    report.fail(
      'origin.public-dns',
      `${url.hostname} resolves to a private or reserved address`,
      'A deployed endpoint must resolve to a public address. Fortress refuses private and reserved targets.',
    );
    return undefined;
  }
  report.pass(
    'origin.public-dns',
    `${url.hostname} resolves to ${addresses.length} public address(es) on TCP ${port}`,
  );
  return addresses;
}
