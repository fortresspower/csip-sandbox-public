# docs/

Documentation for `fortress-csip-sandbox` — a standalone, fully-mocked IEEE 2030.5 / CSIP
sandbox (a spec-compliant Fortress *client* plus a hollow-but-correct example *server*) for
partner enablement.

## Contents

| File | What it covers |
|---|---|
| [`telemetry-extension-strategy.md`](telemetry-extension-strategy.md) | How Fortress carries telemetry that IEEE 2030.5 / CSIP does not natively model, while remaining a strict superset of the standard. Explains the `fortress:*` mRID convention and the `csip-required` / `spec-optional` / `off-spec` tiers used by the point catalog. |

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
