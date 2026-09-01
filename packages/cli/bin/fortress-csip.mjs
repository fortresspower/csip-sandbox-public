#!/usr/bin/env node
// Committed launcher for `fortress-csip`.
//
// npm links this path into node_modules/.bin at install time, which is why it is checked in
// rather than generated: a generated bin does not exist yet when `npm ci` decides what to
// link, and `npx fortress-csip` would then not resolve. The launcher stays stable forever;
// the actual program is the esbuild bundle beside it, produced by the package's build script
// and rebuilt by the repository's postinstall.

import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const bundle = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'fortress-csip.mjs');

try {
  await access(bundle);
} catch {
  process.stderr.write(
    'fortress-csip: the toolkit has not been built yet.\n' +
      '  Run `npm install` in the repository checkout, or `npm run build:cli`.\n',
  );
  process.exit(3);
}

await import(pathToFileURL(bundle).href);
