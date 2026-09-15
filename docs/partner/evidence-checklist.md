# Partner readiness evidence checklist

Complete this checklist before the supervised command rehearsal. Passing it is not standing command
enablement; the first pilot returns to telemetry-only afterward, and any later command requires
separate authorization.

Most of it is produced for you. Run:

```bash
npx fortress-csip conformance https://your-origin.example \
  --cert ./test-client.pem --key ./test-client.key \
  --out ./fortress-csip-evidence.json
```

and attach the generated evidence artifact. The sections below name what that artifact
covers and what still needs a short operator record. Any evidence you add by hand — logs,
screenshots, capacity measurements — must redact private keys, tokens, raw XML payloads,
device serials, and unrelated customer data.

## Server and identity

- [ ] The production origin is public HTTPS on a DNS name and TCP 443.
- [ ] The server certificate validates for that DNS name.
- [ ] A trusted and allowlisted Fortress client certificate fetches `/sep2/capability`.
- [ ] A missing, untrusted, expired, and trusted-but-not-allowlisted client certificate is rejected.
- [ ] The application cannot be reached directly around the TLS terminator.
- [ ] The public router exposes only `/sep2/*` and the agreed non-sensitive health check.
- [ ] State survives ordinary task or process replacement.

## Discovery and in-band enrollment

- [ ] DeviceCapability advertises Time, EndDeviceList, and MirrorUsagePointList.
- [ ] Every list accepts `l=500`, returns no more than 500 items, and preserves its selected `l` in `next` links.
- [ ] Capacity evidence measures real telemetry p95 latency, sustainable writes/second, throttling, and retries at the requested fleet tier, measured against the deployed origin (a local in-memory fixture is not a substitute).
- [ ] The partner sustains the agreed staggered cadence; at 100,000 sites and 300 seconds this averages about 333 standard writes/second.
- [ ] Resource paths can be treated as opaque; the test does not depend on numeric fixed paths.
- [ ] Pagination, relative links, poll rates, and changed resource paths converge.
- [ ] Posting the same LFDI twice creates one logical EndDevice.
- [ ] Device removal is explicit and later reconciliation converges.
- [ ] No human copied or uploaded an EndDevice LFDI.

## Assignment and control

- [ ] Two registered test EndDevices can be discovered while only one is assigned.
- [ ] A control reaches only the assigned, registered, execution-eligible EndDevice.
- [ ] Moving the assignment changes the target without a Fortress deploy or local membership edit.
- [ ] Empty, unknown, duplicate, ineligible, and ambiguous assignments dispatch nobody.
- [ ] Removing an active assignment stands the old target down and restores it.
- [ ] Repeating an mRID is idempotent; materially revising it is rejected.

## Responses, telemetry, and recovery

- [ ] The partner receives the requested accepted, started, and terminal response per EndDevice.
- [ ] Standard MirrorUsagePoint telemetry arrives at the discovered destination.
- [ ] DER status and capability arrive when their destinations are advertised.
- [ ] Missing measurements are absent rather than zero-filled.
- [ ] A partner outage does not duplicate actuation.
- [ ] An owed terminal response survives a Fortress-side service restart and is delivered after recovery.
- [ ] Two connections using overlapping program or control IDs remain isolated.

## Handoff record

This section is not produced by the toolkit. Record it alongside the evidence artifact.

- [ ] Partner and Fortress operating contacts are named.
- [ ] Certificate expiry and rotation owners are named.
- [ ] The initial command bound and supported profile version are recorded.
- [ ] The rollback action is to disable this connection, not to deploy code.
- [ ] Private connectivity and out-of-band EndDevice exchange are absent or documented as approved exceptions.
