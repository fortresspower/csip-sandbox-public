# Connecting to Fortress

The public contract for setting up a real connection. Run `fortress-csip onboarding` for the
same contract in the terminal, and `--template` / `--validate` to prepare your submission.

Nothing on this page is performed by the toolkit. No certificate is issued, no Fortress API is
called, and no connection is activated by running a command — those happen between two
organizations through the agreed secure channel.

## Trust runs in two directions, and they are not symmetric

This is the part that most often gets described backwards.

**Your server certificate uses ordinary public trust.** Fortress validates it through the
standard public trust store, exactly as a browser would. You do not supply Fortress a private
or partner-specific server CA, and Fortress will not pin one.

**The Fortress client certificate is a private identity.** Fortress supplies you the public
issuing chain during onboarding. You install that issuer in your server's *client* trust store
and, separately, allowlist the exact aggregator LFDI derived from the leaf.

Both are required. Trusting the issuer alone means accepting any identity that issuer ever
signs. Allowlisting the LFDI alone means trusting a value anyone could assert. Neither on its
own is authorization — and `fortress-csip demo --mtls` will show you exactly that, on your own
machine, before any of this material exists.

## What each side provides

**You provide:**

- a stable public HTTPS origin on TCP 443, backed by public DNS;
- a server certificate from a CA in the standard public trust store;
- a technical contact and an operations contact;
- your requested fleet and cadence tier;
- a completed conformance evidence artifact.

**Fortress provides:**

- the public chain for one connection-specific client certificate;
- the aggregator LFDI derived from that certificate leaf;
- the SHA-256 fingerprint and expiry of that leaf;
- a stable connection identifier;
- a proposed preflight window.

**You then:**

- install and trust the supplied Fortress client issuer;
- allowlist the exact aggregator LFDI.

## Never exchanged, in either direction

- **Any private key.** If a key ever appears in a message, a ticket, or a submission file,
  treat it as compromised and rotate it. `fortress-csip onboarding --validate` refuses a
  submission containing key material for exactly this reason.
- **A per-device roster.** EndDevice identities are registered in-band, through your
  advertised `EndDeviceList`. Nobody copies an LFDI into a spreadsheet, and no human sends
  Fortress a device list.

## Preparing your submission

```bash
npx fortress-csip onboarding --template --out ./fortress-csip-handoff.json
# fill it in
npx fortress-csip onboarding --validate ./fortress-csip-handoff.json
```

```json
{
  "schema": "fortress-csip-partner-handoff/v1",
  "origin": "https://csip.your-company.example",
  "technicalContact": { "name": "", "email": "" },
  "operationsContact": { "name": "", "email": "" },
  "requestedFleetTier": { "sites": 1000, "standardTelemetrySeconds": 300 },
  "evidenceFile": "fortress-csip-evidence.json"
}
```

Send the validated submission and the evidence artifact it names through the agreed secure
channel. That channel is a matter for the two organizations; this repository does not choose
it for you.

## Before the first supervised command

Enablement is staged, and the first stage executes nothing:

1. **No control execution.** Fortress exercises authentication, discovery, enrollment,
   assignments, and telemetry against your live server without executing any control. This
   proves the connection end to end while nothing can move.
2. **Evidence review.** Both sides review what that phase produced against your conformance
   artifact.
3. **One bounded command rehearsal.** A single control, bounded in watts and duration, agreed
   in advance by both sides.
4. **Return to telemetry-only.** The first pilot ends in viewer-scoped telemetry-only operation.
   Repeated or broader commands require separate Fortress authorization and another agreed window;
   one clean rehearsal is not standing command enablement.

An assignment makes a control *discoverable*. It does not, by itself, grant Fortress
permission to act on a site — those remain separate decisions.

Fortress checks fresh command permission when each new event is admitted. Confirmed acceptance freezes
that event's site and execution route; later permission loss blocks later events but does not cancel
accepted work. Use an explicit cancellation or remove the assignment when accepted work must stop.

## After you are connected

Certificate rotation, outages, throughput changes, and the rollback path are covered in
[operations](./operations.md).
