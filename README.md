<img src="packages/example-server/public/fortress-logo.png" alt="Fortress Power" width="80" />

# fortress-csip-sandbox

A standalone, fully-mocked **IEEE 2030.5 / CSIP** partner-enablement sandbox.

It ships three cooperating artifacts so a VPP/aggregator partner can build their **server**
against the Fortress polling contract before a live connection is enabled:

1. **`@fortress-csip/client-core`** — the production-shaped discovery, in-band enrollment,
   assignment, control lifecycle, telemetry, and secure-transport behavior.
2. **A fully mocked Fortress client** — connects that core to a synthetic battery so the
   complete loop can run without a Fortress backend or physical device.
3. **A hollow-but-correct example server** — a target for the loop and a forkable starting
   point for a partner's own server.

Everything serializes through one shared `protocol` package, so the client and the example
server **cannot drift** from each other or from the wire contract.

---

## Quick start

```bash
docker compose up --build
```

This brings up both services and runs the full loop with zero partner code:

- **example-server** on `http://localhost:7001` — serves 2030.5 discovery / `DERProgram` /
  `DERControl`, accepts telemetry, exposes a `/test/*` admin API, and serves the **partner
  console** (browser UI) at its root.
- **client** on `http://localhost:7100` — polls the server, applies dispatched controls,
  posts synthetic telemetry, and exposes a `/status` inspection endpoint.

### Partner console (browser UI)

Open **`http://localhost:7001/`** for a developer console to drive and observe the sandbox:

- **Dispatch** — compose `opModConnect` / `opModMaxLimW` / `opModFixedW` + an mRID (with
  presets) and watch the closed loop respond live, with a DERControl XML preview.
- **Telemetry** — the canonical 2030.5 telemetry **read**, with the point catalog folded in.
  Pick points by mRID (official or `fortress:`) from an FMP-style points drawer (search,
  Standard/Extended/Complete detail level, lane/tier facets, the full ~750-point dictionary
  grouped by SunSpec model), choose a window (*Latest · Last hour · Last 24h · Walk all*),
  and watch the live `GET /mup/{m}/mr?a=&s=&l=` request preview and the paginated
  `MirrorMeterReadingList` response (per-point chart, table, `all`/`results` + next-page).
  **Live and historical are the same call** — only the §4.6.2 paging params differ;
  `fortress:*` points ride a second MirrorUsagePoint (`/mup/1`).
- **Config** — connection mode, cadence, fixture, the equivalent env vars, and reset.
- A prominent **2030.5 wire log** (the Console layout pins it as a side rail).

**API reference (Swagger UI):** open **`http://localhost:7001/docs`** for an OpenAPI/Swagger
UI over the server — the IEEE 2030.5 (XML) endpoints and the sandbox admin `/test/*` (JSON)
endpoints, with try-it-out. The raw spec is at `/openapi.json`.

It auto-detects the running sandbox and drives the real API **LIVE** (the example-server and
the client's `/status` both send permissive CORS); if neither is reachable it falls back to an
in-browser **simulation** that mirrors the `SyntheticGenerator` physics, so it is demonstrable
even without the stack running. The console loads React/Babel from a CDN, so the browser
needs internet access on first load.

> Provenance: the console is a vendored design prototype (zero-build React under
> `packages/example-server/public/`), served as a static asset — intentionally a drop-in tool,
> not part of the TypeScript build.

Watch the closed loop move telemetry — dispatch a discharge control, then read the client's
state:

```bash
# Inject a -3 kW discharge setpoint via the example-server admin API
curl -s -X POST localhost:7001/test/dercontrol \
  -H 'Content-Type: application/json' \
  -d '{"mRID":"DEMO","opModFixedW":-3000}'

# Within one control-poll interval, the client's reported real power goes negative
curl -s localhost:7100/status
# => {"snapshot":{...,"realPowerW":-3000,...},"lastControl":"DEMO: fixedW=-3000",...}

# Confirm the server received the telemetry the client posted back
curl -s localhost:7001/test/meter-readings
```

The scripted version of this check (used in CI):

```bash
npm run demo          # bash scripts/demo-loop.sh — asserts dispatch moved telemetry
```

### Working on the code

```bash
npm install
npm test              # vitest — unit + integration (client <-> server over loopback)
npm run build         # tsc -b across all packages
```

> Local scripts run TypeScript through `tsx`. The example-server image is a multi-stage build
> that compiles first and copies only runtime dependencies, compiled output, and console assets.

### From sandbox to Fortress polling

Start with the [partner onboarding guide](docs/partner/onboarding.md), then use the
[conformance profile](docs/partner/conformance-profile.md) and
[evidence checklist](docs/partner/evidence-checklist.md) before asking Fortress to connect.
The normal deployed relationship is a partner-owned public HTTPS server on TCP 443. Fortress
initiates every request with a connection-specific client certificate; the partner does not
need private connectivity or inbound access to Fortress. One connection serves the sites in its
current Fortress-granted scope; telemetry and command permission are evaluated separately as
that scope changes.

---

## The two usage modes

**Mode 1 — point the client at your server.** Develop your 2030.5 server, then exercise it
with the correct Fortress client by overriding one environment variable:

```yaml
# docker-compose.override.yml
services:
  client:
    environment:
      CSIP_SERVER_URL: "http://host.docker.internal:9000"   # your server
```

**Mode 2 — fork the example server.** Copy `packages/example-server` as the scaffold for
your own implementation. It is hollow but correct on the receive/serve side (real status
codes, `Location` header on `201 Created`, the `urn:ieee:std:2030.5:ns` namespace), with
intentionally lenient validation so exploratory payloads don't need to be fully populated.

### Client configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `CSIP_SERVER_URL` | `http://localhost:7001` | Base URL of the 2030.5 server to talk to |
| `CSIP_CONTROL_POLL_SEC` | `600` | How often to poll `DERControl` (compose demo uses `10`) |
| `CSIP_TELEMETRY_POST_SEC` | `300` | How often to post telemetry (compose demo uses `10`) |
| `CSIP_CONNECTION_ID` | `sandbox-partner` | Stable connection namespace used by the reusable client state |
| `CSIP_CONTROL_LIST_HREF` | `/derp/0/derc` | Local-demo shortcut; deployed integrations discover this link |
| `CSIP_SUBSCRIPTION` | the five CSIP-required points | Comma-separated catalog point ids this partner receives (see below) |
| `CSIP_INSPECT_PORT` | `7100` | Port for the client's `/status` inspection endpoint |

---

## What the local loop does

The zero-config Docker client intentionally uses fixed local-demo hrefs. It sends:

- `GET /derp/0/derc` — poll the `DERControlList`, apply each control, then `POST /rsps` a
  `DERControlResponse` ack for each.
- `POST /mup/0` — post a single **`MirrorMeterReadingList`** carrying all subscribed
  **reading-type** points for the interval (real/reactive power, frequency, voltage, plus any
  Fortress extension points) — the canonical batch form (IEEE 2030.5 §10.11.3(d)), not one
  POST per point.

**What the example server additionally supports** — present so you can fork it as a complete
scaffold and so a future/your-own client can exercise the rest of the surface:

- `GET /dcap` — minimal discovery (`DeviceCapability`).
- `PUT /edev/0/der/0/ders` — a `DERStatus` route (operational state / connection / SoC).

### Production-shaped client core

The reusable `client-core` is the contract for a deployed integration. It follows advertised,
same-origin links instead of assuming numeric resource paths; registers EndDevices in-band by
LFDI; treats the partner's FunctionSetAssignments as authoritative; persists control and
response state across restarts; separates control, standard telemetry, extension telemetry,
DERStatus, and DERCapability lanes; and requires verified TLS plus a client certificate for
every non-loopback connection. The production-shaped partner-loop tests exercise those paths
against the example server with randomized opaque resource identifiers.

Deployed transports authenticate the partner server with Node's standard public trust store and
authenticate Fortress with the connection-specific client certificate chain. They accept only a
public DNS origin on HTTPS/TCP 443, re-resolve and reject private, mixed, and reserved answers,
follow no redirects or cross-origin links, bound response bytes and deadlines, and use a
connection-scoped circuit breaker. Custom server CA input is available only to explicit
`local-test` fixtures.

For six-figure fleets, one caller-owned round starts with
`ResourceClient.endDeviceFleet()`. The immutable snapshot is bound to that exact
`ResourceClient`, DeviceCapability, and EndDeviceList; pass it to `reconcileFleet`, assignment
reconciliation, and telemetry discovery so inventory is parsed once. A registration change
returns a refreshed snapshot, while an unchanged fleet reuses the exact input snapshot. The
library never hides a parsed snapshot across rounds.

List discovery requests `l=500` when the advertised initial link omits a limit. `ResourceClient`
still rejects pages over 500, more than 200,000 list items, link cycles, or more than 2,048 pages.
`TelemetryPublisher.runDue()` deterministically spreads first-run work over each route's advertised
300/600-second interval; direct `publish()` remains immediate. Telemetry source reads and sends are
bounded at 32 concurrent effects, while enrollment and assignment remain capped at eight.

The checked-in [100,000-site scale evidence](docs/partner/client-core-scale-report.json) used
500-item pages and injected 20 ms per telemetry write. It completed one staggered 60-second slice
in 17.0 seconds at 32-way concurrency. The fleet's sustained floor is about 333 standard telemetry
writes/second (`100,000 / 300`); a partner's real latency, throughput, and error behavior must be
measured in dev before production and must not be inferred from this in-memory fixture.

The production-shaped example server is storage-neutral at its public composition boundary.
`PartnerPersistence`, `PartnerDomain`, `makePartnerApp`, and `makeProductionPartnerApp` accept a
partner-chosen adapter. The repository includes memory and DynamoDB implementations; DynamoDB is
one documented deployment composition, not a protocol or application requirement.

**Control modes that visibly move the synthetic telemetry** (a deliberate subset of the
CSIP BASIC inverter-control matrix):

| Mode | Effect |
|---|---|
| `opModConnect` | connect / disconnect — disconnect drives reported power to 0 |
| `opModMaxLimW` | clamp the maximum reported active power |
| `opModFixedW` | signed setpoint — negative discharges (power < 0, SoC trends down), positive charges |

**Example-server admin (`/test/*`)** — for driving and inspecting the loop:

| Endpoint | Purpose |
|---|---|
| `POST /test/dercontrol` | inject a `DERControl` dispatch (JSON body, e.g. `{"mRID":"X","opModFixedW":-3000}`) |
| `GET /test/meter-readings` | what telemetry the server received |
| `GET /test/der-statuses` | what `DERStatus` documents it received |
| `POST /test/reset` | clear all in-memory stores |

**Client inspection** — `GET /status` returns the current synthetic snapshot, the last
control applied, and the last telemetry-post timestamp, so you can see the client working
without reading XML off the wire.

---

## Telemetry point catalog

The centerpiece deliverable is the catalog in `packages/protocol/src/catalog.ts`: the single
in-code source of truth for how Fortress telemetry maps onto 2030.5. Each entry is keyed on
SunSpec **model id + in-model word offset + point name** (not an absolute Modbus register
address) and falls into one of three tiers:

- **`csip-required`** — the floor that locks the contract: real/reactive power, frequency,
  per-phase voltage (`MirrorMeterReading`s), state-of-charge and operational state
  (`DERStatus`), and storage nameplate (`DERCapability`).
- **`spec-optional`** — beyond the floor but with a real 2030.5 home: AC energy, power
  factor, per-phase current.
- **`off-spec`** — no native 2030.5 slot, split into:
  - **`extension`** — a number with a real unit, carried via a published `fortress:*` mRID
    convention the partner must be told out of band (e.g. State-of-Health % via
    `fortress:soh`, backup-port power via `fortress:backup-power`).
  - **`off-protocol`** — no unit and/or no slot; listed in the catalog purely to document
    the boundary, and **not exposed** (per-cell voltages, CAN-bus diagnostics, vendor alarm
    bitfields).

See [`docs/telemetry-extension-strategy.md`](docs/telemetry-extension-strategy.md) for the
full tier rationale and the `fortress:*` mRID convention.

> **Note on State-of-Health:** SoH is a percentage, but IEEE 2030.5-2018 Annex A `UomType`
> (a `UInt8`) defines **no** percent code — the standard represents percentages with the
> `PercentType` data type, not a unit code. So the `fortress:soh` extension carries
> `uom: 0` (Not applicable) and relies on the published mRID convention for its meaning.

### Reads are per-mRID; the reporter defines the mirror

2030.5 has no runtime point-selection menu over the metering mirror — the mirror is defined
by the reporter (the client decides which `MirrorMeterReading`/`ReadingType` entries it
posts), and the server's only standard lever is `postRate` (cadence, not selection). The
Subscription/Notification function set exists but is the wrong direction for telemetry and is
out of scope here.

A consumer reads telemetry by **addressing the mRID(s) it wants** — there is no gate to ask
permission through. So the sandbox **serves the whole catalog**: ask for any point's mRID and
the read returns a series (synthesized on read when nothing has been posted for it yet). The
**`CSIP_SUBSCRIPTION`** env var only governs what the bundled client *chooses to post*, not
what a reader may request. (In production the *available* set is provisioned per partner —
access control upstream of 2030.5 — and `extension` points still require prior agreement on
the `fortress:*` mRID convention.)

---

## Transport / security

> [!WARNING]
> **The zero-config Docker demo is deliberately local-only. Run it on a network you control.**
>
> - Its local-demo endpoints are open, including `/test/*`, which
>   can inject `DERControl` events and reset server state.
> - It uses plain HTTP for a zero-friction first run.
> - **Permissive CORS** (`Access-Control-Allow-Origin: *`) so the browser console and partner
>   tooling can call it from anywhere.
>
> Never expose local-demo mode to the public internet or point it at grid-connected equipment.

Every non-loopback `client-core` connection requires verified TLS and a client certificate.
The partner server certificate must chain to Node's standard public trust store; deployed
connections neither accept nor store a partner-specific root CA. The private Fortress CA is for
the client identity, which the partner verifies. Custom CA trust is restricted to explicit
`local-test` fixtures.
The example server also has an explicit `CSIP_SERVER_MODE=partner` bootstrap with durable
persistence and certificate-derived connection authorization; it does not expose the console
or `/test/*`. This repository deliberately includes no Fortress cloud infrastructure or
credentials. A deployed server must terminate or implement mTLS, keep the application task
unreachable except through that verified boundary, and expose only its IEEE 2030.5 graph plus
a non-sensitive health check.

---

## Scope

In scope (v1): the **one-connection partner polling loop** — permission-derived site scope,
certificate-derived aggregator identity,
in-band `EndDevice` registration, assignment discovery, `MirrorUsagePoint` telemetry,
`DERStatus`/`DERCapability`, and `DERControl` poll/apply/respond with a closed feedback loop.
The production-shaped example server provides durable state and an allowlisted identity adapter
for a trusted mTLS terminator; the public client requires mTLS for every deployed connection.

Out of scope (v1): PIN-based enrollment, the Subscription/Notification function set, public-cloud
deployment and PKI operation, and the full BASIC inverter-control matrix. TLS termination and the
private operator channel remain deployment responsibilities, not public sandbox infrastructure.
There is no partner-facing Fortress management API.

---

## Reference

- [`docs/telemetry-extension-strategy.md`](docs/telemetry-extension-strategy.md) — how
  Fortress carries telemetry the standard does not model, as a strict superset of 2030.5.
- The normative specifications (IEEE Std 2030.5-2018; the SunSpec CSIP Implementation Guide
  and Conformance Test Procedures) are copyrighted by their publishers and are **not**
  redistributed here. See [`docs/README.md`](docs/README.md) for where to obtain them.

All 2030.5 documents use the namespace `urn:ieee:std:2030.5:ns`.

---

## License

Copyright (c) 2026 Fortress Power, LLC. All rights reserved.

**This project is not open source.** It is licensed for use, modification, and redistribution
**solely for the purpose of integrating with Fortress Power cloud services, APIs, and IT
systems** — which includes forking the example server as the starting point for your own
IEEE 2030.5 / CSIP server that talks to Fortress.

The Fortress Power name and logo are trademarks and are **not** licensed; remove them from any
derivative work you distribute.

See [LICENSE](LICENSE) for the full terms. For permissions beyond its scope, contact Fortress
Power.
