# Self-test and conformance

`fortress-csip conformance` executes the [conformance profile](./conformance-profile.md)
against a live IEEE 2030.5 connection and writes the evidence artifact you attach to your
Fortress handoff.

## Two modes

```bash
# Prove the harness, using the bundled example server. No endpoint, no certificate.
npx fortress-csip conformance --self-test --out ./conformance-self-test.json

# Prove your server.
npx fortress-csip conformance https://csip.your-company.example \
  --cert ./test-client.pem --key ./test-client.key \
  --out ./fortress-csip-evidence.json
```

Both run the same checks through the same code. The self-test is worth wiring into your own
CI: anything that fails there is a bug in the toolkit, not in your server.

## What it does to your server

This command mutates, deliberately. It:

- registers two synthetic EndDevices in-band, through your advertised `EndDeviceList`;
- posts lifecycle responses to the `replyTo` link your control advertises;
- publishes telemetry to the MirrorUsagePoint it discovers;
- removes the synthetic devices at the end, where your server exposes a `DELETE` on the
  discovered path. Pass `--keep-test-devices` to leave them for investigation.

The two device identities are LFDI-shaped values derived from your origin and the session
seed. They identify nothing: no real site, no customer, and no device that exists anywhere.
**No human ever sends Fortress a real EndDevice LFDI.**

## The two operator pauses

Assignment and control authoring live behind your own authenticated operator boundary. The
toolkit does not perform them and does not ask you to expose an API so that it could. It
prints what it needs and then watches the connection:

```text
ACTION REQUIRED

Two synthetic EndDevices are now registered.
Using your normal operator tooling, assign only test device "test-device-alpha"
to a DERProgram intended for this rehearsal.

The toolkit will poll for up to 10 minute(s). No Fortress-specific admin
endpoint is required — use whatever tooling you normally use.
```

The control instruction names the exact `mRID`, start time, duration, watts, and response
settings to publish. Adjust the wait with `--wait-minutes N`.

If nobody acts before the deadline, the check is recorded as `manual` with the action still to
take — not as a failure of your server, and not as a silent pass. Re-run once the action is
done; the session resumes.

## The checks

| Check | What it proves |
|---|---|
| `enrollment.first-registration` | An EndDevice can be registered in-band. |
| `enrollment.idempotent-registration` | The same LFDI posted twice converges on one EndDevice. |
| `enrollment.two-distinct-devices` | Two LFDIs get distinct resources. |
| `discovery.opaque-paths` | Resource paths were followed as opaque links, never guessed. |
| `pagination.accepts-l500` | Lists accept `l=500` and stay within the page cap. |
| `pagination.preserves-page-size` | `all`, `results`, and `next` links agree across pages. |
| `assignment.exactly-one-target` | Exactly one test device discovers a DERProgram. |
| `assignment.empty-dispatches-none` | The unassigned device discovers nothing, so it can receive nothing. |
| `assignment.move-retargets` | Moving the assignment retargets discovery with no Fortress-side change. |
| `control.fixed-w-bounded` | The bounded fixed-W control reaches only the assigned device. |
| `control.mrid-idempotent` | Repeated polling does not re-deliver the same mRID. |
| `responses.accepted` | The accepted response is posted on delivery and acknowledged. |
| `responses.started` | The started response is accepted at the `replyTo` link. |
| `responses.terminal` | The terminal response is delivered — after a client restart. |
| `telemetry.standard-mup` | Standard telemetry is accepted at the discovered destination. |
| `telemetry.der-status` | DERStatus is written where a destination is advertised. |
| `telemetry.der-capability` | DERCapability is written where a destination is advertised. |
| `recovery.no-duplicate-delivery` | A restarted client does not deliver the control twice. |
| `recovery.owed-response-retried` | A response owed at restart survives it and is delivered. |
| `isolation.connection-scope` | Two connections with overlapping identifiers stay isolated (self-test only). |

`recovery.owed-response-retried` is not a formality. The terminal response is deliberately
held back before the simulated restart, so there is genuinely something outstanding for the
restart to preserve.

## The session file

A run writes `.fortress-csip-session.json` (override with `--session PATH`) so that pausing
for an operator action does not force re-registration. It holds the synthetic identities, the
generated control parameters, and the client-side effects needed to prove restart behaviour.

It never holds your private key, and it deliberately does not hold the resource cache — that
cache contains raw server payloads, which have no business in a file you might attach to a
ticket.

A session belongs to one origin. Point the command at a different server and it starts fresh
rather than resuming with devices that do not exist there.

## The evidence artifact

The artifact validates against
[`schemas/fortress-csip-evidence-v1.schema.json`](../../schemas/fortress-csip-evidence-v1.schema.json),
and is checked against it at generation time. A sample run is at
[`docs/examples/conformance-self-test.json`](../examples/conformance-self-test.json).

It carries stable check IDs, bounded messages, the origin you supplied, and your certificate's
LFDI, fingerprint, and expiry. It carries no PEM body, no private key, no raw XML, no response
headers, and no device serials — it is designed to be safe to forward.

## What it does not prove

Conformance is a correctness gate, not a capacity one. Local in-memory scale evidence is not a
substitute for measuring your deployed system's p95 telemetry latency, sustainable
writes/second, throttling behaviour, and retry behaviour at your requested fleet tier. At
100,000 sites on a 300-second interval that averages about 333 standard writes/second. Measure
it against your real origin and record the result in the
[evidence checklist](./evidence-checklist.md).
