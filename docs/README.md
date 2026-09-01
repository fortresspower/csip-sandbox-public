# docs/

Documentation for `fortress-csip-sandbox` — a standalone, fully-mocked IEEE 2030.5 / CSIP
sandbox (a spec-compliant Fortress *client* plus a hollow-but-correct example *server*) for
partner enablement.

## Partner journey

Fortress acts as the IEEE 2030.5 client. Your system hosts the IEEE 2030.5 server.

The toolkit CLI is the front door; these pages are the contract behind it.

| Step | Page | What it covers |
|---|---|---|
| 1 | [`partner/onboarding.md`](partner/onboarding.md) | One-connection, permission-derived polling onboarding, public/server versus private/client trust, storage composition, and certificate rotation. |
| 2 | [`partner/conformance-profile.md`](partner/conformance-profile.md) | The minimum public server, discovery, assignment, control, response, and telemetry contract your server must meet. |
| 3 | [`partner/evidence-checklist.md`](partner/evidence-checklist.md) | The evidence gate before Fortress enables polling and commands, most of it produced by `fortress-csip conformance`. |

## Reference

| File | What it covers |
|---|---|
| [`telemetry-extension-strategy.md`](telemetry-extension-strategy.md) | How Fortress carries telemetry that IEEE 2030.5 / CSIP does not natively model, while remaining a strict superset of the standard. Explains the `fortress:*` mRID convention and the `csip-required` / `spec-optional` / `off-spec` tiers used by the point catalog. |

## Maintainers

These pages are about building this repository, not about integrating with Fortress.

| File | What it covers |
|---|---|
| [`maintainers/client-core-release.md`](maintainers/client-core-release.md) | The reproducible, checksum-verified client-core release artifact. |

Start with the [top-level README](../README.md) for a quick start, the console tour, and the
telemetry/control scope statement.

## Normative specifications

The normative specifications are copyrighted by their publishers and are **not** redistributed
in this repository. Obtain them directly:

| Document | Publisher | Where |
|---|---|---|
| IEEE Std 2030.5-2018 (Smart Energy Profile Application Protocol) | IEEE | [standards.ieee.org](https://standards.ieee.org/) |
| CSIP Implementation Guide | SunSpec Alliance | [sunspec.org/csip-conformance](https://sunspec.org/csip-conformance/) |
| CSIP Conformance Test Procedures | SunSpec Alliance | [sunspec.org/csip-conformance](https://sunspec.org/csip-conformance/) |

All 2030.5 documents in this sandbox use the namespace `urn:ieee:std:2030.5:ns`.
