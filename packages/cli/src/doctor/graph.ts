import {
  CsipAuthenticationError,
  CsipAuthorizationError,
  CsipProtocolError,
  CsipResponseTooLargeError,
  MemorySessionStore,
  ResourceClient,
  createCsipTransport,
  type CsipTransport,
} from '@fortress-csip/client-core';
import { describeError } from '../errors.js';
import type { ReportBuilder } from '../report/report.js';
import type { TargetMode } from '../report/types.js';

/**
 * Authenticated, read-only inspection of the advertised resource graph.
 *
 * Every request here is a GET. Doctor must never register a device, publish telemetry, create
 * an assignment, or consume a control — a partner runs it against a live server, possibly one
 * already carrying real sites, and a diagnostic that mutates is a diagnostic nobody runs
 * twice. `doctor.test.ts` asserts that only GETs leave the process.
 *
 * The reads go through client-core's ResourceClient rather than a second HTTP/XML stack, so
 * the same-origin rule, pagination bounds, poll-rate validation, and redirect refusal being
 * checked are the real ones Fortress will apply, not a reimplementation that could drift.
 */

export const SEP2_NAMESPACE = 'urn:ieee:std:2030.5:ns';

export interface GraphCheckOptions {
  origin: string;
  /** Address already resolved and approved by the origin checks. */
  address: string;
  deviceCapabilityPath: string;
  mode: TargetMode;
  certificate: Uint8Array;
  privateKey: Uint8Array;
  certificateAuthorities?: Uint8Array[];
}

export function createDoctorTransport(options: GraphCheckOptions): CsipTransport {
  return createCsipTransport({
    baseUrl: options.origin,
    environment: options.mode === 'local' ? 'local-test' : 'deployed',
    tls: {
      certificate: options.certificate,
      privateKey: options.privateKey,
      ...(options.certificateAuthorities === undefined
        ? {}
        : { certificateAuthorities: options.certificateAuthorities }),
    },
    // Do not reopen a validate-then-connect gap by resolving the hostname again here.
    resolveDns: async () => [options.address],
  });
}

/**
 * Result of the first authenticated read.
 *
 * This single request answers the authorization question, so it is made once and its outcome
 * handed to both the `client-certificate.authorized` check and the graph checks. The raw body
 * comes back with it because the namespace is a property of the document that the parser has
 * already discarded by the time a typed object exists.
 */
export type AuthorizationProbeFailure =
  | 'authentication'
  | 'authorization'
  | 'redirect'
  | 'too-large'
  | 'other';

export type AuthorizationProbe =
  | { ok: true; body: string; bodyBytes: number }
  | { ok: false; reason: AuthorizationProbeFailure; detail: string };

export async function probeAuthorization(
  transport: CsipTransport,
  deviceCapabilityPath: string,
): Promise<AuthorizationProbe> {
  try {
    const response = await transport.get(deviceCapabilityPath);
    return { ok: true, body: response.body, bodyBytes: Buffer.byteLength(response.body) };
  } catch (error) {
    // These two have completely different fixes, and a server that can tell them apart says
    // so with 401 vs 403. One that cannot — a terminator rejecting at the TLS layer — is not
    // penalised for it, but the partner is still told which layer refused them.
    if (error instanceof CsipAuthorizationError) {
      return { ok: false, reason: 'authorization', detail: describeError(error, 200) };
    }
    if (error instanceof CsipAuthenticationError) {
      return { ok: false, reason: 'authentication', detail: describeError(error, 200) };
    }
    // These two are transport faults an anonymous probe cannot observe on a server that
    // correctly refuses anonymous clients, so the authenticated read is where they surface.
    if (error instanceof CsipResponseTooLargeError) {
      return { ok: false, reason: 'too-large', detail: describeError(error, 200) };
    }
    if (error instanceof CsipProtocolError && /redirect/i.test(error.message)) {
      return { ok: false, reason: 'redirect', detail: describeError(error, 200) };
    }
    return { ok: false, reason: 'other', detail: describeError(error, 200) };
  }
}

export async function runGraphChecks(
  report: ReportBuilder,
  transport: CsipTransport,
  deviceCapabilityPath: string,
  probe: AuthorizationProbe,
): Promise<void> {
  const store = new MemorySessionStore();
  const resources = new ResourceClient({ transport, store });

  if (!probe.ok) {
    reportGraphAccessFailure(report, probe, deviceCapabilityPath);
    return;
  }
  const rawBody = probe.body;

  if (rawBody.includes(SEP2_NAMESPACE)) {
    report.pass('graph.namespace', `document declares ${SEP2_NAMESPACE}`);
  } else {
    report.fail(
      'graph.namespace',
      'the DeviceCapability document does not declare the IEEE 2030.5 namespace',
      `Serve documents in the ${SEP2_NAMESPACE} namespace.`,
    );
  }

  let capability;
  try {
    capability = await resources.deviceCapability(deviceCapabilityPath);
    report.pass('graph.device-capability', `DeviceCapability parsed from ${deviceCapabilityPath}`);
  } catch (error) {
    report.fail(
      'graph.device-capability',
      `DeviceCapability could not be parsed: ${describeError(error, 200)}`,
      'Serve a well-formed DeviceCapability with Time, EndDeviceList, and MirrorUsagePointList links.',
    );
    // Every remaining graph check reads from this document; without it they would all report
    // the same failure with less information.
    for (const id of [
      'graph.time-link',
      'graph.end-device-list-link',
      'graph.mirror-usage-point-list-link',
      'graph.same-origin-links',
      'graph.positive-rates',
      'graph.bounded-pagination',
    ]) {
      report.skip(id, 'requires a parseable DeviceCapability');
    }
    return;
  }

  checkLink(report, 'graph.time-link', 'TimeLink', capability.TimeLink,
    'Advertise TimeLink so Fortress can align control schedules to your clock.');
  checkLink(report, 'graph.end-device-list-link', 'EndDeviceListLink', capability.EndDeviceListLink,
    'Advertise EndDeviceListLink. Fortress registers EndDevices in-band through it.');
  checkLink(report, 'graph.mirror-usage-point-list-link', 'MirrorUsagePointListLink',
    capability.MirrorUsagePointListLink,
    'Advertise MirrorUsagePointListLink so telemetry has a discovered destination.');

  checkSameOrigin(report, resources, [
    ['TimeLink', capability.TimeLink],
    ['EndDeviceListLink', capability.EndDeviceListLink],
    ['MirrorUsagePointListLink', capability.MirrorUsagePointListLink],
  ]);

  checkPollRate(report, capability.pollRate);
  await checkPagination(report, resources, capability.EndDeviceListLink);
}

function checkLink(
  report: ReportBuilder,
  id: string,
  name: string,
  value: string | undefined,
  remediation: string,
): void {
  if (value === undefined || value === '') {
    report.fail(id, `DeviceCapability does not advertise ${name}`, remediation);
    return;
  }
  report.pass(id, `${name} advertised`);
}

function checkSameOrigin(
  report: ReportBuilder,
  resources: ResourceClient,
  links: Array<[string, string | undefined]>,
): void {
  const present = links.filter((entry): entry is [string, string] => Boolean(entry[1]));
  if (present.length === 0) {
    report.skip('graph.same-origin-links', 'no links were advertised to check');
    return;
  }
  const offending: string[] = [];
  for (const [name, href] of present) {
    try {
      // canonicalHref applies the transport's own rule and performs no I/O, so a cross-origin
      // link is rejected here without a request ever reaching the third-party host.
      resources.canonicalHref(href);
    } catch (error) {
      offending.push(`${name} (${describeError(error, 120)})`);
    }
  }
  if (offending.length > 0) {
    report.fail(
      'graph.same-origin-links',
      `advertised links leave the origin: ${offending.join('; ')}`,
      'Every CSIP link must be same-origin and free of URL credentials. Fortress refuses to follow links off your origin.',
    );
    return;
  }
  report.pass('graph.same-origin-links', `${present.length} advertised link(s) are same-origin`);
}

function checkPollRate(report: ReportBuilder, pollRate: number | undefined): void {
  if (pollRate === undefined) {
    report.warn(
      'graph.positive-rates',
      'DeviceCapability advertises no pollRate',
      'Advertise a pollRate so Fortress paces its polling to what your service expects.',
    );
    return;
  }
  if (!Number.isSafeInteger(pollRate) || pollRate <= 0) {
    report.fail(
      'graph.positive-rates',
      `pollRate is ${pollRate}, which is not a positive whole number of seconds`,
      'Advertise pollRate as a positive integer number of seconds.',
    );
    return;
  }
  report.pass('graph.positive-rates', `pollRate is ${pollRate} seconds`);
}

async function checkPagination(
  report: ReportBuilder,
  resources: ResourceClient,
  endDeviceListLink: string | undefined,
): Promise<void> {
  if (endDeviceListLink === undefined || endDeviceListLink === '') {
    report.skip('graph.bounded-pagination', 'requires an advertised EndDeviceListLink');
    return;
  }
  try {
    // A read-only walk. ResourceClient requests l=500 and enforces the page-size cap, the
    // page-count cap, cycle detection, and all/results consistency as it goes; anything the
    // profile forbids surfaces here as a CsipDiscoveryError rather than as silent truncation.
    const devices = await resources.endDevices(endDeviceListLink);
    report.pass(
      'graph.bounded-pagination',
      `EndDeviceList paginated correctly at l=500 (${devices.length} device(s) discovered)`,
    );
  } catch (error) {
    report.fail(
      'graph.bounded-pagination',
      `EndDeviceList pagination is not usable: ${describeError(error, 200)}`,
      'Accept l=500, cap pages at 500 items, keep `all` stable across pages, preserve the selected l in next links, and avoid link cycles.',
    );
  }
}

/** Report the graph as unreachable, once, with the reason the probe established. */
function reportGraphAccessFailure(
  report: ReportBuilder,
  probe: Extract<AuthorizationProbe, { ok: false }>,
  path: string,
): void {
  const { summary, remediation } =
    probe.reason === 'redirect'
      ? {
          summary: 'the DeviceCapability path answered with a redirect',
          remediation:
            'Fortress never follows redirects on CSIP routes. Serve the resource directly at its advertised path.',
        }
      : probe.reason === 'too-large'
        ? {
            summary: 'the DeviceCapability response exceeded the client byte limit',
            remediation:
              'Keep individual CSIP responses within the 1 MiB client limit; paginate lists with `l`.',
          }
      : probe.reason === 'authorization'
      ? {
          summary: 'the server rejected this client identity',
          remediation:
            'Allowlist this certificate’s aggregator LFDI, and confirm its issuer is installed in your client trust store.',
        }
      : probe.reason === 'authentication'
        ? {
            summary: 'the TLS handshake was rejected when presenting this client certificate',
            remediation:
              'Install the issuing chain for this client certificate in your server’s client trust store.',
          }
        : {
            summary: `GET ${path} failed: ${probe.detail}`,
            remediation:
              'Confirm the DeviceCapability path is correct and served over the authenticated CSIP route.',
          };

  report.fail('graph.device-capability', summary, remediation);
  for (const id of [
    'graph.namespace',
    'graph.time-link',
    'graph.end-device-list-link',
    'graph.mirror-usage-point-list-link',
    'graph.same-origin-links',
    'graph.positive-rates',
    'graph.bounded-pagination',
  ]) {
    report.skip(id, 'requires an authorized read of DeviceCapability');
  }
}
