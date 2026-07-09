# Telemetry extension strategy — decisions

How Fortress carries telemetry that IEEE 2030.5 / CSIP does not natively model, while
staying a strict **superset** of the standard (not a fork, not a second protocol).

Status: decided 2026-06-02. Applies to the `protocol` catalog and the client/example-server
telemetry path in this repo.

## The goal

One telemetry contract, not two. Partners (VPP/aggregators) integrate **one** wire shape.
Fortress-specific data that the standard has no home for rides the *same* shape via
namespaced identifiers, rather than living behind a separate proprietary API.

## Decisions

### 1. 2030.5 is the partner contract; stay conformant on the standard lane
Control (`DERControl` poll/apply/respond) and the CSIP-required telemetry/status subset
(real/reactive power, frequency, voltage, SoC, operational state, nameplate) use the
standard 2030.5 representation. This lane must remain certifiable — nothing non-standard
is mixed into it.

### 2. Vendor telemetry reuses the 2030.5 shape — no separate API
Off-spec points are carried as ordinary `MirrorMeterReading`s using the existing
`MirrorMeterReading` / `ReadingType` types. **No new resource types, no schema changes, no
new verbs.** The only additions are *data*: catalog entries plus namespaced mRIDs. This is
the catalog's existing `extension` tier (already used for `fortress:soh`), generalized.

### 3. Off-protocol points are scalars → they become extensions
The points previously tiered `off-protocol` are all scalars and fit a `MirrorMeterReading`:

| Point | mRID | uom | scale (`powerOfTenMultiplier`) |
|---|---|---|---|
| per-cell voltage (`model42111.vCellN`) | `fortress:cell-N-voltage` | 29 (Volts) | −3 (millivolts) |
| CAN error counter (`model39998.canErr`) | `fortress:can-err-count` | 0 (n/a) | 0 |
| alarm bitfield (`model7998.alarmBits`) | `fortress:alarm-bits` | 0 (n/a) | 0 |

The thing 2030.5 genuinely lacks for per-cell data is **identity**, not value shape —
there is no "cell N" resource. Identity is supplied by convention in the mRID
(`fortress:cell-7-voltage`). Cell *count* is per-device, so the set of cell mRIDs is
generated from `NCell` (a catalog-enumeration detail, not a protocol problem).

Net effect: the `off-protocol` tier collapses into `extension`; only the unit/scale and
mRID differ from a standard reading.

### 4. Keep vendor readings in their own lane
Vendor `fortress:*` readings go in a **separate `MirrorUsagePoint`** (and/or a
`urn:fortresspower:telemetry:ns` namespace / distinct endpoint) from the conformance-required
MUP. Still 100% standard resources — this is hygiene so a CSIP conformance test never trips
over `fortress:*` / `uom:0` readings on the certifiable mirror.

### 5. Time-range history uses standard pagination — no spec extension
2030.5 list query parameters (§4.6.2) are `a` (after a time), `l` (limit / page size),
`s` (start index). A consumer requests "after X" and pages forward, **stopping when
timestamps pass Y** — the upper bound is enforced reader-side, not by the protocol. This is
sufficient; we deliberately do **not** add a custom `before`/`b` parameter. (The spec *would*
allow it — unknown query params must be ignored, §4.6.2 — but pagination already covers the
need, so we don't extend.)

### 6. Publish the mRID dictionary
A `fortress:*` mRID is opaque on its own. The out-of-band dictionary — what each mRID means,
its unit, and scale — *is* the contract for the vendor lane. Maintaining and sharing it is a
required deliverable, not optional.

## The governing rule

**Extend only where the standard has no home for the data; stay standard everywhere else.**
- Extend: vendor data points with no 2030.5 identity → `fortress:*` mRIDs.
- Don't extend: anything the standard already does — time-range queries (pagination),
  control, the required telemetry subset.

This keeps Fortress a true superset: maximally compatible with any 2030.5 consumer, with the
smallest possible surface of its own to maintain.
