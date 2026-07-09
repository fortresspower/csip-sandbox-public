<img src="packages/example-server/public/fortress-logo.png" alt="Fortress Power" width="80" />

# fortress-csip-sandbox

A standalone, fully-mocked **IEEE 2030.5 / CSIP** partner-enablement sandbox.

It ships two artifacts so a VPP/aggregator partner can build their **server** against a
correct Fortress **client** before Fortress's real backend exists:

1. **A spec-compliant, fully-mocked Fortress client** — runs the CSIP telemetry + control
   sequence the way the real Fortress client will. Its synthetic "backend" (sites, DERs,
   telemetry) is faked; there is no real database, no managers, no gRPC. **The client's
   behavior is the contract.**
2. **A hollow-but-correct example server** — a target so the loop runs end-to-end with no
   partner code, and a forkable starting point for a partner's own server.

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

> The packages run their TypeScript entrypoints directly via `tsx` (the package export maps
> resolve to source `.ts`), so the containers do not need a separate compiled `dist/` to run.

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
| `CSIP_SUBSCRIPTION` | the five CSIP-required points | Comma-separated catalog point ids this partner receives (see below) |
| `CSIP_INSPECT_PORT` | `7100` | Port for the client's `/status` inspection endpoint |

---

## What the loop does

**What the v1 client actually sends** (this is the contract you can rely on today):

- `GET /derp/0/derc` — poll the `DERControlList`, apply each control, then `POST /rsps` a
  `DERControlResponse` ack for each.
- `POST /mup/0` — post a single **`MirrorMeterReadingList`** carrying all subscribed
  **reading-type** points for the interval (real/reactive power, frequency, voltage, plus any
  Fortress extension points) — the canonical batch form (IEEE 2030.5 §10.11.3(d)), not one
  POST per point. Resource hrefs are fixed in v1 (the client does not yet walk `dcap`
  discovery — see "Not yet wired" below).

**What the example server additionally supports** — present so you can fork it as a complete
scaffold and so a future/your-own client can exercise the rest of the surface:

- `GET /dcap` — minimal discovery (`DeviceCapability`).
- `PUT /edev/0/der/0/ders` — a `DERStatus` route (operational state / connection / SoC).

### Not yet wired in v1

The sandbox is the **telemetry + control happy path**. These are deliberately deferred (the
example server already has the routes; the v1 client just doesn't drive them yet):

- **`dcap`→`FunctionSetAssignments`→`DERProgram` discovery** — the client uses fixed hrefs
  instead of walking the discovery chain.
- **`MirrorUsagePoint` registration** (`GET /mup` → `POST` a MUP → store the returned mRID)
  — the client posts to a fixed `/mup/0`.
- **`DERStatus` reporting, including State-of-Charge.** `model802.SoC` is in the default
  subscription, but it is a `der-status-field` (it belongs in a `DERStatus` PUT, not a
  `MirrorMeterReading`), so the v1 client does not emit it. Only the reading-type points
  reach the server today.

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
> **This sandbox has no security controls. Run it only on a network you control.**
>
> - **No authentication.** Every endpoint is open, including the `/test/*` admin API, which
>   can inject `DERControl` events and reset server state.
> - **No transport security.** Plain HTTP by default, for a zero-friction first run.
> - **No mTLS.** The CSIP certificate profile is *not* implemented here.
> - **Permissive CORS** (`Access-Control-Allow-Origin: *`) so the browser console and partner
>   tooling can call it from anywhere.
>
> Never expose this to the public internet, and never point it at real distributed energy
> resources or any grid-connected equipment. It is a development and integration-testing
> tool. A production 2030.5 deployment must implement the CSIP certificate profile (mTLS).

When you wire TLS for your own testing, terminate it in front of, or inside, the example
server; the client talks to whatever `CSIP_SERVER_URL` points at.

---

## Scope

In scope (v1): the **telemetry + control happy path** — minimal discovery, `MirrorUsagePoint`
telemetry, `DERStatus`/`DERCapability`, and `DERControl` poll/apply/respond with a closed
feedback loop.

Out of scope (v1): EndDevice/PIN registration, the Subscription/Notification function set,
mTLS enforcement, server-side aggregator conformance, and the full BASIC inverter-control
matrix.

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
