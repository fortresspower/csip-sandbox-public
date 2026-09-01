# Operations

Day-two concerns for a live Fortress connection: rotating the client identity, handling
outages, and the rollback path. The full onboarding narrative is in
[onboarding](./onboarding.md); this page is the operational subset you will actually return
to.

## Certificate rotation without downtime

The aggregator LFDI is the lowercase hexadecimal encoding of the first 20 bytes of SHA-256
over the client leaf certificate's DER form. You can compute it yourself from the public
certificate — you never need to take a value on trust:

```bash
npx fortress-csip lfdi ./fortress-client.pem
```

```text
Aggregator LFDI: 0123456789abcdef0123456789abcdef01234567
Expires:         2027-09-01T00:00:00.000Z
SHA-256:         ...64 lowercase hex...
```

Rotation is staged rather than swapped, so no window exists in which an unverified credential
has replaced a working one:

1. **Stage.** Fortress issues a second connection-specific certificate and gives you its
   public chain, LFDI, fingerprint, and expiry.
2. **Allowlist both.** You allowlist the staged LFDI *alongside* the active one. Both are
   authorized at once — this is the step that removes the downtime.
3. **Preflight.** Fortress connects using the staged identity and confirms discovery works.
   The old identity is still live throughout.
4. **Promote.** Fortress promotes the staged credential once you authorize it.
5. **Remove.** You revoke the old LFDI.

Reversing steps 2 and 4 — promoting before both are allowlisted — is what causes an outage.

`fortress-csip lfdi` warns when a certificate is within 30 days of expiry, and
`fortress-csip doctor` records certificate expiry in its report. Name a rotation owner on both
sides while onboarding, not when the certificate is about to lapse.

## Verifying a change before it reaches production

Both diagnostic commands are safe to run against a live server:

```bash
# Read-only. Never mutates.
npx fortress-csip doctor https://csip.your-company.example \
  --cert ./fortress-client.pem --key ./fortress-client.key
```

`doctor` issues only `GET` requests. `conformance` does mutate — it registers synthetic
devices — so prefer a staging origin for routine re-runs, or accept the two synthetic
EndDevices it creates and removes.

## Outages and recovery

The profile requires that a partner outage does not duplicate actuation, and that a
Fortress-side service restart does not deliver a control twice. Both are properties of
idempotency keyed on the control `mRID` and its material fingerprint, not of uptime.
`fortress-csip conformance` exercises both as `recovery.no-duplicate-delivery` and
`recovery.owed-response-retried`.

A response you owe stays owed. Keep accepting a `DERControlResponse` at the advertised
`replyTo` link after a control's interval has passed, so a recovering client can settle what
it still owes.

## Capacity

Conformance is a correctness gate, not a capacity one. Measure against your deployed origin,
not a local fixture:

- p95 telemetry write latency;
- sustainable writes/second at your requested fleet tier;
- throttling behaviour under load;
- retry behaviour.

At 100,000 sites on a 300-second standard interval, that averages about 333 standard
writes/second. Fortress staggers the first round deterministically across each route's
advertised interval rather than bursting at connection start.

## Rollback

The rollback action for a connection is to **disable that connection**, not to deploy code.
Assignment changes and site-scope changes likewise require no deployment on either side — an
assignment change is visible to Fortress purely through discovery, which
`assignment.move-retargets` proves.

Record the rollback owner alongside the operating contacts in the
[evidence checklist](./evidence-checklist.md).
