// Build the `fortress-csip` executable.
//
// The workspace packages publish their TypeScript sources through their exports maps
// (`"." : "./src/index.ts"`), which suits `tsc` and vitest but is not something plain Node can
// execute. So the executable is bundled: esbuild resolves and inlines the workspace sources,
// leaving a single ESM file that runs under `node` with no loader, no transpiler, and no
// registry fetch. Type checking is a separate concern and stays with `tsc -b`.
//
// Real npm dependencies are left external — they are already installed in node_modules, and
// bundling them would inline megabytes of AWS SDK that only one optional persistence adapter
// uses.

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(HERE, 'dist');
const ENTRY_NAME = 'fortress-csip';

await mkdir(OUTPUT_DIR, { recursive: true });

await build({
  entryPoints: [join(HERE, 'src', 'main.ts')],
  outdir: OUTPUT_DIR,
  entryNames: ENTRY_NAME,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Code splitting keeps a lazily imported command in its own chunk. Without it, esbuild
  // inlines `await import(...)` into the entry file and every invocation — `help` included —
  // pays to load the express server the mutual-TLS rehearsal composes.
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  // Bundle the workspace packages (they resolve to .ts); keep everything else external.
  external: ['express', 'fast-xml-parser', '@aws-sdk/*'],
  legalComments: 'eof',
  logLevel: 'warning',
});

console.log(`fortress-csip: built dist/${ENTRY_NAME}.mjs`);
