#!/usr/bin/env node
// Compatibility wrapper for `npm run cert:lfdi`.
//
// The single implementation is `fortress-csip lfdi`, which shares client-core's
// `aggregatorLfdiFromCertificate` rather than deriving the value a second way. This module
// keeps the previous script path and its exported helper working for existing callers.

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { aggregatorLfdiFromCertificate } from '../packages/client-core/src/identity.js';

export async function certificateLfdi(path: string): Promise<string> {
  return aggregatorLfdiFromCertificate(await readFile(path));
}

async function main(): Promise<void> {
  const [path, extra] = process.argv.slice(2);
  if (!path || extra) {
    throw new Error(
      'usage: npm run cert:lfdi -- path/to/client-certificate.pem\n' +
        '   or: npx fortress-csip lfdi path/to/client-certificate.pem',
    );
  }
  console.log(await certificateLfdi(path));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
