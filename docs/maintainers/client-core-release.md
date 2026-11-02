# Client-core release bundle

> **Maintainer documentation.** Partners integrating with Fortress do not need this page —
> start at [`../partner/start-here.md`](../partner/start-here.md).

The release bundle is how a downstream consumer takes a pinned, reviewable build of
`client-core` without a private npm registry and without depending on this repository's
source layout or a sibling checkout. Everything below happens inside this repository; how a
particular consumer installs the resulting artifact is that consumer's own concern.

## Artifact contract

The bundle contains exactly three output files under the ignored `release/` directory:

- `fortress-csip-client-core-<version>.tgz` — the installable ESM and CommonJS package;
- `manifest.json` — source commit, core and protocol versions, protocol input hashes,
  bundled third-party package names, package file inventory, and tarball SHA-256; and
- `SHA256SUMS` — the standard checksum line for the tarball.

The tarball contains compiled client-core JavaScript and declarations. Its protocol runtime
is compiled from the pinned protocol package, bundled with its runtime dependencies into
`vendor/protocol.js`, and reachable only from the package's internal code. The public export
map exposes only `@fortress-csip/client-core`; it does not expose protocol parsers,
serializers, constants, workspace paths, or `src` files. Public declarations use
client-core-owned `Csip*` types.

The generated package has no runtime registry dependencies. Its smoke test installs with an
empty npm cache and `--offline`, imports the ESM and CommonJS APIs, derives a device LFDI, rejects leaked
protocol exports, and typechecks an empty TypeScript consumer, including deployed TLS material
with a client certificate chain and private key but no custom server CA.

## Build and prove the release

Commit the source first, then run one command from a clean checkout:

```bash
npm ci
npm run release:bundle
```

`release:bundle` performs the release build, not just `npm pack`. It:

1. refuses uncommitted source other than the known local `.mcp.json` file and ignored
   release output;
2. regenerates the protocol catalog and fails if generated source was not committed;
3. force-builds all TypeScript projects so stale incremental metadata cannot hide drift;
4. stages only compiled output and release metadata;
5. bundles the exact compiled protocol runtime and records every protocol input hash;
6. runs `npm pack`, writes the manifest and checksum, verifies the extracted inventory; and
7. installs and exercises the package offline in empty JavaScript and TypeScript fixtures.

Recheck an existing output without rebuilding:

```bash
npm run release:verify
```

Verification fails for a missing file, altered tarball byte, mismatched checksum, changed
file inventory, changed embedded build metadata, protocol bundle drift, a protocol-package
reference in declarations, or a source-only import.

Rebuilding the same source commit must produce byte-identical tarballs and identical
manifests. The test suite performs that double build and corrupts a copy to prove the
negative checksum path.

## Consume the verified artifact

A downstream build installs the tarball from a checked-in path and verifies its SHA-256
against `SHA256SUMS` before installation. Keep the tarball, manifest, and checksum together
in the same change as the dependency bump so a reviewer can re-derive the artifact from the
recorded source commit. The consumer needs no access to this repository at build time and no
registry token.

When the public client-core contract changes, increment the semantic version before
building. Any protocol-runtime change also increments the pinned protocol version and is
visible in the manifest even when the client-core API is unchanged.

## 0.4.2 release note

Adds optional connection-scoped private server trust through `CsipConnectionServerTrust`
and `CsipTransportOptions.serverTrust`. Explicit policies require a canonical matching HTTPS
origin and non-empty CA bytes, preventing private trust from leaking to another origin or
silently falling back to system roots. Default server trust and all network restrictions
remain unchanged.

After merging the versioned source, run `npm ci` and `npm run release:bundle` from the clean
merged commit, then `npm run release:verify`. Run `npm run test:client-core-scale` to record
the scale report alongside the generated tarball, manifest and checksums. Distribute those
artifacts with the merged source provenance; do not relabel or replace a 0.4.1 artifact.
