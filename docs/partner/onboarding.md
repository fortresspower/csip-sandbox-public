# Partner onboarding

This is the handoff for a partner that has built an IEEE 2030.5 server against the Fortress
CSIP sandbox and wants Fortress to begin polling it. The normal connection is public HTTPS
with mutual TLS. Fortress initiates every request; polling-only onboarding does not require
the partner to reach a Fortress endpoint.

## What each side provides

The partner provides:

- one stable public HTTPS origin on TCP 443, backed by public DNS;
- the server trust chain and the client-certificate issuer(s) it accepts;
- a server implementation that passes the conformance profile and evidence checklist;
- an operator contact for certificate rotation, outages, and assignment changes; and
- an application allowlist entry for the Fortress aggregator LFDI.

Fortress provides:

- the public chain for one connection-specific aggregator client certificate;
- the aggregator LFDI computed from that certificate; and
- the connection profile name and a proposed shadow-test window.

Fortress never sends the client private key to the partner. The partner never sends a
per-device roster to Fortress. Fortress derives each partner-scoped EndDevice LFDI and
registers it in-band through the discovered EndDeviceList resource.

## The onboarding sequence

1. The partner shares its origin, server chain, accepted client CA, and completed evidence
   checklist through the approved secure channel.
2. Fortress creates a disabled connection and a connection-specific client certificate.
3. Fortress computes the aggregator LFDI from the leaf certificate and gives the partner
   the public certificate chain and LFDI. The partner trusts the issuer and allowlists that
   exact LFDI; either check alone is insufficient.
4. Fortress preflights TLS and fetches `/sep2/capability`. A wrong server name, untrusted
   server, untrusted client, or trusted-but-not-allowlisted client must fail.
5. Fortress enables shadow mode. It registers EndDevices and follows assignments but cannot
   deliver a control to the device plane.
6. The partner assigns one registered EndDevice to the agreed DERProgram. Both sides verify
   that the discovered graph has exactly one intended eligible target.
7. After the shadow evidence passes, Fortress enables commands for that connection and runs
   one bounded rehearsal. The partner confirms accepted, started, and terminal responses plus
   telemetry on the same connection.
8. Fortress and the partner record the enabled state, operating contacts, certificate expiry,
   and rollback owner. No application deployment is required for later assignment changes.

Commands remain disabled if any device identity is ambiguous, a discovered link crosses the
configured origin, TLS verification is bypassed, an assignment is empty or ineligible, or an
owed response cannot be recovered after an outage.

## Public and private surfaces

The partner's public service exposes its IEEE 2030.5 graph and a non-sensitive health check.
Its console, test controls, database, logs, and operator mutation API are not public. A deployed
copy of the example server should forward only `/sep2/*` and `/healthz`; operators publish
controls and move assignments through an authenticated administrative channel that uses the
same domain and persistence layer as the server.

Public mTLS is the supported default. VPN, VPC peering, PrivateLink, static IP allowlisting, or
out-of-band EndDevice maintenance is an exception requiring separate review, not an onboarding
prerequisite.

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

## Related contracts

- [Conformance profile](./conformance-profile.md)
- [Evidence checklist](./evidence-checklist.md)
- [Release bundle](./release-bundle.md)
