import { readFile, stat } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { OperationalError } from './errors.js';

/**
 * Locate the toolkit checkout.
 *
 * `demo` needs the compose file and `conformance --self-test` needs the bundled example
 * server, and both must work regardless of the directory the partner ran the command from.
 * The search walks up from the executable, not from the working directory, and identifies the
 * root by the workspace manifest rather than by a hard-coded relative depth — so moving the
 * executable inside the package does not silently break it.
 */
export async function findRepositoryRoot(startDirectory: string): Promise<string> {
  const { root } = parse(startDirectory);
  let directory = startDirectory;
  for (;;) {
    if (await isToolkitRoot(directory)) return directory;
    if (directory === root) break;
    directory = dirname(directory);
  }
  throw new OperationalError(
    'could not locate the fortress-csip repository checkout',
    'Run this command from a clone of the toolkit repository, or reinstall with `npm install`.',
  );
}

async function isToolkitRoot(directory: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
      name?: string;
      workspaces?: unknown;
    };
    if (manifest.name !== 'fortress-csip-sandbox' || manifest.workspaces === undefined) {
      return false;
    }
    await stat(join(directory, 'docker-compose.yml'));
    return true;
  } catch {
    return false;
  }
}
