# Partner onboarding

This is the handoff for a partner that has built an IEEE 2030.5 server against the Fortress
CSIP sandbox and wants Fortress to begin polling it. The normal connection is public HTTPS
with mutual TLS. Fortress initiates every request; polling-only onboarding does not require
the partner to reach a Fortress endpoint.

One durable partner connection serves the sites currently included in its Fortress-granted
scope. Fortress reconciles that scope on each polling round; the partner does not maintain a
separate site roster in Fortress.

## What each side provides

The partner provides:

- one stable public HTTPS origin on TCP 443, backed by public DNS;
- a server certificate issued by a CA in the standard public trust store;
- the client-certificate issuer or issuers it accepts;
- a server implementation that passes the conformance profile and evidence checklist;
- an operator contact for certificate rotation, outages, and assignment changes; and
- application allowlist entries for the active and, during rotation, staged Fortress
  aggregator LFDIs.

Fortress provides:

- the public chain for one connection-specific aggregator client certificate;
- the aggregator LFDI computed from that certificate; and
- the stable connection identifier and a proposed preflight window.

Fortress never sends the client private key to the partner. The partner never sends a
per-device roster to Fortress. Fortress derives each partner-scoped EndDevice LFDI and
registers it in-band through the discovered EndDeviceList resource.

## The onboarding sequence

1. The partner shares its origin, accepted client CA, and completed evidence checklist through
   the approved secure channel. Fortress does not ingest or pin a partner-specific server CA.
2. Fortress creates an operator-paused connection and a connection-specific client certificate.
3. Fortress computes the aggregator LFDI from the leaf certificate and gives the partner
   the public certificate chain and LFDI. The partner trusts the issuer and allowlists that
   exact LFDI; either check alone is insufficient.
4. Fortress verifies the server with the standard public trust store, completes mutual TLS,
   and fetches `/sep2/capability`. A wrong server name, untrusted server, untrusted client, or
   trusted-but-not-allowlisted client must fail.
5. While operator contact remains paused, both sides validate the graph and evidence. Fortress
   then reconciles and registers the sites currently permitted for telemetry; later permission
   changes add or remove sites without a new partner connection.
6. The partner assigns one registered EndDevice to the agreed DERProgram. An assignment makes
   a control discoverable but does not grant Fortress permission to act on that site.
7. The partner publishes one bounded rehearsal control. Fortress consumes it only for a site
   with current command permission, rechecks permission immediately before dispatch, and posts
   accepted, started, and terminal responses on the same connection.
8. Fortress and the partner record the active connection, operating contacts, certificate
   expiry, and rollback owner. Later assignment and site-scope changes require no deployment.

Fortress makes no site contact when a fresh scope decision is unavailable. It dispatches no
command if current command permission is absent, any device identity is ambiguous, a discovered
link crosses the configured origin, TLS verification is bypassed, an assignment is empty or
ineligible, or an owed response cannot be recovered after an outage.

## Public and private surfaces

The partner's public service exposes its IEEE 2030.5 graph and a non-sensitive health check.
Its console, test controls, database, logs, and operator mutation API are not public. A deployed
copy of the example server should forward only `/sep2/*` and `/healthz`; operators publish
controls and move assignments through an authenticated administrative channel that uses the
same domain and persistence layer as the server.

Fortress exposes no partner-facing management API for this flow. Lifecycle, scope, credential,
pause, and teardown operations remain Fortress-operated internal actions.

Public mTLS is the supported default. VPN, VPC peering, PrivateLink, static IP allowlisting, or
out-of-band EndDevice maintenance is an exception requiring separate review, not an onboarding
prerequisite.

The partner server certificate and Fortress client certificate have different trust roles. The
server certificate must chain to standard public trust; Fortress does not store a custom partner
root. The private Fortress issuing CA is used only for the client identity that the partner
authenticates. Custom server CA input in `client-core` is confined to explicit `local-test`
fixtures.

## Certificate identity and rotation

The aggregator LFDI is the lowercase hexadecimal encoding of the first 20 bytes of SHA-256
over the client leaf certificate's DER form. It can be computed from the public certificate:

```bash
npm run cert:lfdi -- ./fortress-client-certificate.pem
```

For rotation, Fortress stages a second certificate, gives its new LFDI and public chain to the
partner, and preflights it while the old identity remains active. Fortress promotes the staged
credential only after the partner authorizes it, then the partner revokes the old LFDI. There
is no window in which an unverified credential replaces the working one.

## Choosing example-server storage

The example server's protocol routes, `PartnerDomain`, operator commands, and
`PartnerPersistence` contract do not depend on DynamoDB. Compose the production-shaped runtime
with `makeProductionPartnerApp({ persistence })` and the adapter selected by the partner. The
included memory adapter is useful for local fixtures; `DynamoPartnerPersistence` and
`makeProductionAppFromEnvironment` demonstrate one durable deployment composition, not a
storage requirement.

## Related contracts

- [Conformance profile](./conformance-profile.md)
- [Evidence checklist](./evidence-checklist.md)
- [Release bundle](./release-bundle.md)
