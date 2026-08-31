# Fortress polling conformance profile

This profile is the minimum server contract for a partner that wants Fortress to poll and
control assigned devices. Resource paths are opaque. A conforming server must advertise and
honor links; Fortress does not integrate fixed numeric paths.

## Transport and authentication

- Serve HTTPS on a public DNS name and TCP 443 with TLS 1.2 or newer.
- Require a client certificate and validate its chain and validity.
- Authorize the presented leaf by aggregator LFDI in addition to trusting its issuer.
- Reject plaintext, redirects, cross-origin links, URL credentials, and private or reserved
  DNS results for a deployed connection.
- Never require inbound connectivity to Fortress in the polling profile.

The DeviceCapability entry point is `/sep2/capability`. A `401` means the client identity was
not established; `403` means the certificate was verified but its aggregator LFDI is not
authorized. Other client errors should be stable and bounded. Transient overload uses `429` or
`5xx` so Fortress can retry without treating malformed data as recoverable.

## Required resource graph

DeviceCapability must link to Time, EndDeviceList, and MirrorUsagePointList. For each EndDevice,
the server supports:

- list discovery by LFDI with pagination;
- idempotent `POST` to the discovered EndDeviceList and a `Location` response;
- `DELETE` at the discovered EndDevice resource;
- FunctionSetAssignments and assigned DERProgram discovery;
- a DERControlList per assigned DERProgram;
- the control's discovered response destination;
- standard MirrorUsagePoint publication; and
- DER status and capability destinations when advertised.

`pollRate` and `postRate` are positive seconds. Fortress honors slower telemetry rates and clamps
faster telemetry requests to a five-minute minimum. Lists support `s` and `l` pagination. Fortress
requests `l=500` when an advertised initial list link omits `l`; the partner must accept and return
up to 500 items per page, and every `next` link must preserve the server-selected page size. A
smaller page remains protocol-correct, but it does not meet the six-figure production cadence gate.
Links may change, but must remain same-origin and form a bounded, unambiguous graph.

### 100,000-site telemetry capacity

Fortress staggers the first `runDue` work deterministically across each route's advertised interval;
it does not burst 100,000 posts at connection startup. At a 300-second standard telemetry interval,
100,000 sites require an average of about 333 writes/second. Client-core permits at most 32
simultaneous telemetry source reads or writes (enrollment and assignment remain capped at eight).

The local scale gate injects 20 ms write latency and proves a 60-second slice completes inside the
manager's 20-second reporting timeout. That is fixture evidence, not a claim about a deployed
partner. The dev rehearsal must measure the partner's actual p95 latency, sustainable request rate,
throttling, and retry behavior at the agreed fleet tier before production approval.

## Device identity and assignments

An EndDevice LFDI is 40 lowercase hexadecimal characters and is stable for one partner/site
relationship. Fortress sends it in-band; the partner stores the posted identity and returns it
through discovery. Duplicate or ambiguous LFDIs are an error.

The partner owns assignments. Only EndDevices whose discovered FunctionSetAssignments link to a
DERProgram are targets for that program. Fortress intersects those LFDIs with its registered,
execution-eligible devices and dispatches nobody on a missing, empty, stale, or ambiguous result.
Removing an active assignment produces a stand-down through the normal cancellation and restore
path; it does not fall back to a fleet broadcast.

## Initial control profile

The initial interoperable control is a bounded `DERControl` using `opModFixedW`. The interval uses
epoch seconds, has a positive duration, and is bounded to 900 seconds by the example server.
Deployment policy may impose a smaller per-device limit. Mixing `opModFixedW` with unsupported
control modes is rejected.

The server supplies:

- an immutable `mRID`;
- `creationTime`, `EventStatus`, and interval;
- the DERProgram primacy;
- `responseRequired`; and
- `replyTo` whenever a response is requested.

For an existing mRID, only a status transition to cancellation or supersession is allowed. A
material change to timing, program, response contract, or command body requires a new mRID.
Repeated polling and manager restart must not cause a second delivery.

## Lifecycle responses

Fortress preserves the partner mRID in every response and scopes internal idempotency by connection.
The supported outcomes include accepted, started, completed, cancelled, superseded, no participation,
rejected, and failed. Responses are per assigned EndDevice LFDI. Requested terminal responses remain
owed across a partner outage and are retried after recovery.

## Telemetry

The standard MirrorUsagePoint lane contains available readings for active power and may include
reactive power, frequency, voltage, state of charge, connection state, and operating state. DERStatus
and DERCapability are published at their discovered destinations. A missing measurement is omitted;
it is never fabricated as zero.

Fortress-only measurements use a separate MirrorUsagePoint and `fortress:*` mRIDs. A generic partner
can ignore that extension lane without affecting standard telemetry. Stale samples are rejected and
telemetry work is isolated from control polling.

## Data handling

Diagnostics may contain the connection ID, LFDI, control IDs, stage, outcome, counts, and timestamps.
They must not contain private keys, PEM bodies, raw XML, gateway serials, arbitrary remote hrefs, or
unbounded partner-provided labels.
