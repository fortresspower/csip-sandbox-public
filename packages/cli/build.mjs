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

import { chmod, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(HERE, 'dist', 'fortress-csip.mjs');

await mkdir(dirname(OUTPUT), { recursive: true });

await build({
  entryPoints: [join(HERE, 'src', 'main.ts')],
  outfile: OUTPUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Bundle the workspace packages (they resolve to .ts); keep everything else external.
  external: ['express', 'fast-xml-parser', '@aws-sdk/*'],
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'eof',
  logLevel: 'warning',
});

await chmod(OUTPUT, 0o755);
console.log(`fortress-csip: built ${OUTPUT.slice(HERE.length + 1)}`);
