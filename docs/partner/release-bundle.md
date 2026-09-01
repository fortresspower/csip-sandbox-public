# Client-core release bundle

The release bundle is the promotion boundary between this repository and `cmsandbox`.
It avoids a private npm registry while ensuring the manager consumes one pinned, reviewable
artifact rather than source files or a sibling checkout.

## Artifact contract

The bundle contains exactly three output files under the ignored `release/` directory:

- `fortress-csip-client-core-<version>.tgz` — the installable ESM package;
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
empty npm cache and `--offline`, imports the ESM API, derives a device LFDI, rejects leaked
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

## Promote into `cmsandbox`

Copy all three verified files into `cmsandbox/libs/csip-release/`. Keep the tarball,
manifest, and checksum in the same commit as the manager dependency change. The manager
Docker build installs the tarball from its checked-in path and verifies the SHA-256 before
installation; it does not read this repository, use a registry token, or change the legacy
`@fortress-csip/protocol` dependency used elsewhere in `cmsandbox`.

When the public client-core contract changes, increment the semantic version before
building. Any protocol-runtime change also increments the pinned protocol version and is
visible in the manifest even when the client-core API is unchanged.
