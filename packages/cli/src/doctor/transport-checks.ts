import type { ReportBuilder } from '../report/report.js';
import type { TargetMode } from '../report/types.js';
import { probeAnonymously, type ProbeOutcome, type ProbedCertificate } from './probe.js';

/**
 * Transport and mutual-TLS enforcement checks, run without a client certificate.
 *
 * The question these answer is not "can I connect" but "does this server refuse a client that
 * has no identity". A partner whose server happily serves DeviceCapability to anyone has not
 * built a CSIP server; they have built a public XML feed, and finding that out here rather
 * than during onboarding is the point of the command.
 */

export interface TransportCheckOptions {
  url: URL;
  address: string;
  hostname: string;
  mode: TargetMode;
  certificateAuthorities?: Uint8Array[];
  probe?: typeof probeAnonymously;
}

export async function runTransportChecks(
  report: ReportBuilder,
  options: TransportCheckOptions,
): Promise<void> {
  const probe = options.probe ?? probeAnonymously;
  const outcome = await probe({
    url: options.url,
    address: options.address,
    certificateAuthorities: options.certificateAuthorities,
  });

  checkServerCertificate(report, outcome, options);
  checkHostname(report, outcome, options.hostname);
  checkMutualTlsRequired(report, outcome);
  checkNoRedirect(report, outcome);
  checkResponseBounds(report, outcome);
}

function certificateOf(outcome: ProbeOutcome): ProbedCertificate | undefined {
  return outcome.kind === 'response' || outcome.kind === 'tls-rejected'
    ? outcome.certificate
    : undefined;
}

function checkServerCertificate(
  report: ReportBuilder,
  outcome: ProbeOutcome,
  options: TransportCheckOptions,
): void {
  if (options.url.protocol !== 'https:') {
    report.skip('transport.server-certificate', 'plain HTTP in local mode: no server certificate');
    return;
  }
  if (outcome.kind === 'timeout') {
    report.fail(
      'transport.server-certificate',
      'the TLS handshake did not complete before the deadline',
      'Confirm the origin is listening and reachable from the public internet.',
    );
    return;
  }
  if (outcome.kind === 'network-error') {
    report.fail(
      'transport.server-certificate',
      `could not connect (${outcome.code})`,
      'Confirm the host is listening on this port and that no firewall blocks it.',
    );
    return;
  }

  const certificate = certificateOf(outcome);
  if (certificate === undefined) {
    // A rejection before any certificate was presented is still an enforcing server; the
    // mutual-TLS check below is the one that judges that. Here it is simply unknown.
    report.skip(
      'transport.server-certificate',
      'the peer closed the handshake before its certificate could be inspected',
    );
    return;
  }

  const trusted =
    certificate.authorized || (options.mode === 'local' && options.certificateAuthorities !== undefined);
  if (!trusted && certificate.authorizationError !== undefined) {
    const remediation =
      options.mode === 'deployed'
        ? 'Deployed connections use the standard public trust store. Serve a certificate from a publicly trusted CA.'
        : 'Pass the issuing root with --ca for a local rehearsal.';
    report.fail(
      'transport.server-certificate',
      `the server certificate was not trusted (${certificate.authorizationError})`,
      remediation,
    );
    return;
  }
  report.pass(
    'transport.server-certificate',
    `valid for ${certificate.subjectCommonName ?? options.hostname}, expires ${certificate.validTo ?? 'unknown'}`,
  );
}

function checkHostname(report: ReportBuilder, outcome: ProbeOutcome, hostname: string): void {
  const certificate = certificateOf(outcome);
  if (certificate === undefined) {
    report.skip('transport.hostname', 'no server certificate was observed');
    return;
  }
  const names = [
    ...certificate.subjectAltNames,
    ...(certificate.subjectCommonName === undefined ? [] : [certificate.subjectCommonName]),
  ];
  if (names.some((name) => matchesHostname(name, hostname))) {
    report.pass('transport.hostname', `certificate covers ${hostname}`);
    return;
  }
  report.fail(
    'transport.hostname',
    `the certificate does not cover ${hostname}`,
    'Issue a certificate whose subjectAltName includes the exact origin hostname Fortress will connect to.',
  );
}

/** Wildcard matching per the usual single-label rule. */
function matchesHostname(pattern: string, hostname: string): boolean {
  const candidate = hostname.toLowerCase();
  const name = pattern.toLowerCase();
  if (name === candidate) return true;
  if (!name.startsWith('*.')) return false;
  const suffix = name.slice(1);
  if (!candidate.endsWith(suffix)) return false;
  return !candidate.slice(0, candidate.length - suffix.length).includes('.');
}

function checkMutualTlsRequired(report: ReportBuilder, outcome: ProbeOutcome): void {
  if (outcome.kind === 'tls-rejected') {
    report.pass('mtls.required', 'an anonymous client was rejected during the TLS handshake');
    return;
  }
  if (outcome.kind === 'timeout' || outcome.kind === 'network-error') {
    report.skip('mtls.required', 'the endpoint could not be reached to test anonymous access');
    return;
  }
  if (outcome.status === 401 || outcome.status === 403) {
    report.pass('mtls.required', `an anonymous client was rejected with HTTP ${outcome.status}`);
    return;
  }
  if (outcome.status >= 200 && outcome.status < 300) {
    report.fail(
      'mtls.required',
      `an anonymous client received HTTP ${outcome.status} — mutual TLS is not enforced`,
      'Require and verify a client certificate on the CSIP routes. Serving DeviceCapability to an unauthenticated caller exposes your fleet graph.',
    );
    return;
  }
  // Anything else — a 404, a 5xx, a terminator's own error page — is not a success, so the
  // anonymous caller did not get in. Report it without claiming enforcement was proven.
  report.warn(
    'mtls.required',
    `an anonymous client received HTTP ${outcome.status} rather than a clear rejection`,
    'Prefer a TLS-layer rejection or a stable 401/403 so the failure mode is unambiguous.',
  );
}

function checkNoRedirect(report: ReportBuilder, outcome: ProbeOutcome): void {
  if (outcome.kind !== 'response') {
    report.skip('transport.no-redirect', 'no HTTP response was received');
    return;
  }
  if (outcome.status >= 300 && outcome.status < 400 && outcome.status !== 304) {
    report.fail(
      'transport.no-redirect',
      `the endpoint answered with a ${outcome.status} redirect`,
      'Fortress never follows redirects on CSIP routes. Serve the resource directly at its advertised path.',
    );
    return;
  }
  report.pass('transport.no-redirect', 'no redirect on the DeviceCapability path');
}

function checkResponseBounds(report: ReportBuilder, outcome: ProbeOutcome): void {
  if (outcome.kind !== 'response') {
    report.skip('transport.response-bounds', 'no HTTP response was received');
    return;
  }
  if (outcome.truncated) {
    report.fail(
      'transport.response-bounds',
      'the response exceeded the client byte limit and was cut off',
      'Keep individual CSIP responses within the 1 MiB client limit; paginate lists with `l`.',
    );
    return;
  }
  report.pass('transport.response-bounds', `response was ${outcome.bodyBytes} bytes, within limits`);
}
