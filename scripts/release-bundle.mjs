#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import {
  access,
  copyFile,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build as esbuild } from 'esbuild';

const execFile = promisify(execFileCallback);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT = join(ROOT, 'release');
const CORE_PACKAGE_PATH = join(ROOT, 'packages/client-core/package.json');
const PROTOCOL_PACKAGE_PATH = join(ROOT, 'packages/protocol/package.json');
const CORE_DIST = join(ROOT, 'packages/client-core/dist');
const PROTOCOL_DIST = join(ROOT, 'packages/protocol/dist');
const SCHEMA_VERSION = 1;

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function sha256File(path) {
  return sha256(await readFile(path));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function requiredFile(path) {
  try {
    await access(path);
  } catch {
    throw new Error(`required release input is missing: ${relative(ROOT, path)}`);
  }
}

async function walkFiles(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await walk(root);
  return files.sort();
}

async function fileInventory(root) {
  return Promise.all((await walkFiles(root)).map(async (path) => ({
    path: relative(root, path).split(sep).join('/'),
    sha256: await sha256File(path),
    bytes: (await stat(path)).size,
  })));
}

function assertSemanticVersion(version, name) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`${name} must have a semantic version before release`);
  }
}

function assertSafeRelativePath(path, label, allowSubdirectories = true) {
  if (typeof path !== 'string' || path.length === 0 || isAbsolute(path) || path.includes('\\')) {
    throw new Error(`${label} is not a safe relative path`);
  }
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')
    || (!allowSubdirectories && basename(path) !== path)) {
    throw new Error(`${label} is not a safe relative path`);
  }
}

async function copyCompiledCore(stage) {
  const destination = join(stage, 'dist');
  const vendorPath = join(stage, 'vendor/protocol.js');
  await cp(CORE_DIST, destination, { recursive: true });
  let rewrites = 0;
  for (const path of await walkFiles(destination)) {
    if (!path.endsWith('.js')) continue;
    const relativeVendor = relative(dirname(path), vendorPath).split(sep).join('/');
    const vendorSpecifier = relativeVendor.startsWith('.') ? relativeVendor : `./${relativeVendor}`;
    const source = await readFile(path, 'utf8');
    const rewritten = source.replaceAll("'@fortress-csip/protocol'", `'${vendorSpecifier}'`)
      .replaceAll('"@fortress-csip/protocol"', `"${vendorSpecifier}"`);
    if (rewritten !== source) {
      rewrites += 1;
      await writeFile(path, rewritten);
    }
  }
  if (rewrites === 0) throw new Error('compiled client core did not contain the expected protocol runtime import');
}

async function bundleProtocol(stage) {
  const output = join(stage, 'vendor/protocol.js');
  await mkdir(dirname(output), { recursive: true });
  const result = await esbuild({
    entryPoints: [join(PROTOCOL_DIST, 'index.js')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    legalComments: 'eof',
    metafile: true,
    logLevel: 'silent',
  });
  const bundledPackages = new Set();
  for (const input of Object.keys(result.metafile.inputs)) {
    const normalized = input.split(sep).join('/');
    const marker = 'node_modules/';
    const index = normalized.lastIndexOf(marker);
    if (index < 0) continue;
    const parts = normalized.slice(index + marker.length).split('/');
    bundledPackages.add(parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]);
  }
  return { output, bundledPackages: [...bundledPackages].sort() };
}

async function bundleCommonJsCore(stage) {
  const output = join(stage, 'dist-cjs/index.cjs');
  await mkdir(dirname(output), { recursive: true });
  await esbuild({
    absWorkingDir: stage,
    entryPoints: ['dist/index.js'],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    legalComments: 'eof',
    logLevel: 'silent',
  });
  return output;
}

async function assertReleaseSurface(stage) {
  for (const path of await walkFiles(stage)) {
    const normalized = relative(stage, path).split(sep).join('/');
    if (normalized.startsWith('src/') || normalized.includes('/src/')) {
      throw new Error(`release contains a source-only path: ${normalized}`);
    }
    if (!/\.(?:js|d\.ts)$/.test(normalized)) continue;
    const text = await readFile(path, 'utf8');
    if (text.includes('@fortress-csip/protocol')) {
      throw new Error(`release leaks the protocol package through ${normalized}`);
    }
    if (/from\s+['"][^'"]*\/src\//.test(text)) {
      throw new Error(`release contains a source-only import in ${normalized}`);
    }
  }
}

async function npmPack(stage, destination) {
  await mkdir(destination, { recursive: true });
  const { stdout } = await execFile('npm', ['pack', stage, '--json', '--pack-destination', destination], {
    cwd: ROOT,
    maxBuffer: 10 * 1024 * 1024,
  });
  const result = stdout.trim() === '' ? [] : JSON.parse(stdout);
  if (result.length === 0) {
    const tarballs = (await readdir(destination)).filter((entry) => entry.endsWith('.tgz'));
    if (tarballs.length === 1) return { path: join(destination, tarballs[0]), details: { filename: tarballs[0] } };
  }
  if (!Array.isArray(result) || result.length !== 1 || !result[0]?.filename) {
    throw new Error('npm pack did not return exactly one tarball');
  }
  return { path: join(destination, result[0].filename), details: result[0] };
}

export async function buildReleaseBundle({
  outputDir = DEFAULT_OUTPUT,
  sourceCommit,
  root = ROOT,
} = {}) {
  if (resolve(root) !== ROOT) throw new Error('alternate source roots are not supported');
  if (!sourceCommit || !/^[0-9a-f]{7,64}$/.test(sourceCommit)) {
    throw new Error('sourceCommit must be a 7-64 character lowercase hexadecimal revision');
  }
  await Promise.all([
    requiredFile(join(CORE_DIST, 'index.js')),
    requiredFile(join(CORE_DIST, 'index.d.ts')),
    requiredFile(join(PROTOCOL_DIST, 'index.js')),
  ]);
  const corePackage = await readJson(CORE_PACKAGE_PATH);
  const protocolPackage = await readJson(PROTOCOL_PACKAGE_PATH);
  assertSemanticVersion(corePackage.version, 'client core');
  assertSemanticVersion(protocolPackage.version, 'protocol');
  if (corePackage.dependencies?.['@fortress-csip/protocol'] !== protocolPackage.version) {
    throw new Error('client-core and protocol workspace versions are not pinned to the same release');
  }

  const temporary = await mkdtemp(join(tmpdir(), 'csip-release-'));
  try {
    const stage = join(temporary, 'package');
    const packed = join(temporary, 'packed');
    await mkdir(stage, { recursive: true });
    await copyCompiledCore(stage);
    const protocol = await bundleProtocol(stage);
    await bundleCommonJsCore(stage);
    const protocolSourceFiles = await fileInventory(PROTOCOL_DIST);
    const protocolBundleSha256 = await sha256File(protocol.output);
    const packageJson = {
      name: corePackage.name,
      version: corePackage.version,
      description: 'Reusable Fortress IEEE 2030.5 client core with a pinned, private protocol runtime.',
      type: 'module',
      main: './dist-cjs/index.cjs',
      module: './dist/index.js',
      types: './dist/index.d.ts',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.js',
          require: './dist-cjs/index.cjs',
        },
      },
      engines: { node: '>=22.12.0' },
      sideEffects: false,
      files: ['dist', 'dist-cjs', 'vendor', 'BUILD-METADATA.json', 'README.md'],
    };
    const buildMetadata = {
      schemaVersion: SCHEMA_VERSION,
      sourceCommit,
      package: { name: corePackage.name, version: corePackage.version },
      protocolRuntime: {
        name: protocolPackage.name,
        version: protocolPackage.version,
        entry: 'vendor/protocol.js',
        sha256: protocolBundleSha256,
        sourceFiles: protocolSourceFiles,
        bundledPackages: protocol.bundledPackages,
      },
    };
    await writeFile(join(stage, 'package.json'), stableJson(packageJson));
    await writeFile(join(stage, 'BUILD-METADATA.json'), stableJson(buildMetadata));
    await writeFile(join(stage, 'README.md'), [
      '# @fortress-csip/client-core',
      '',
      'Pinned Fortress IEEE 2030.5 client core. The protocol runtime is private and bundled.',
      'Import only from `@fortress-csip/client-core`.',
      '',
    ].join('\n'));
    await assertReleaseSurface(stage);
    const inventory = await fileInventory(stage);
    const tarball = await npmPack(stage, packed);
    const tarballSha256 = await sha256File(tarball.path);
    const manifest = {
      ...buildMetadata,
      files: inventory,
      tarball: {
        file: tarball.details.filename,
        sha256: tarballSha256,
        bytes: (await stat(tarball.path)).size,
      },
    };

    await mkdir(outputDir, { recursive: true });
    const expected = new Set([tarball.details.filename, 'manifest.json', 'SHA256SUMS']);
    for (const entry of await readdir(outputDir)) {
      if (!expected.has(entry)) throw new Error(`release output contains an unexpected file: ${entry}`);
    }
    await copyFile(tarball.path, join(outputDir, tarball.details.filename));
    await writeFile(join(outputDir, 'manifest.json'), stableJson(manifest));
    await writeFile(join(outputDir, 'SHA256SUMS'), `${tarballSha256}  ${tarball.details.filename}\n`);
    return manifest;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function verifyReleaseBundle(outputDir = DEFAULT_OUTPUT) {
  const manifestPath = join(outputDir, 'manifest.json');
  const checksumPath = join(outputDir, 'SHA256SUMS');
  await Promise.all([requiredFile(manifestPath), requiredFile(checksumPath)]);
  const manifest = await readJson(manifestPath);
  if (manifest.schemaVersion !== SCHEMA_VERSION) throw new Error('unsupported release manifest schema');
  assertSafeRelativePath(manifest.tarball?.file, 'release tarball filename', false);
  const tarballPath = join(outputDir, manifest.tarball?.file ?? '');
  await requiredFile(tarballPath);
  const actual = await sha256File(tarballPath);
  if (actual !== manifest.tarball.sha256) throw new Error('release tarball checksum drift');
  const checksum = await readFile(checksumPath, 'utf8');
  if (checksum !== `${actual}  ${manifest.tarball.file}\n`) throw new Error('SHA256SUMS does not match the release manifest');

  const temporary = await mkdtemp(join(tmpdir(), 'csip-release-verify-'));
  try {
    const archive = (await execFile('tar', ['-tzf', tarballPath])).stdout.split('\n').filter(Boolean);
    if (archive.length === 0 || archive.some((entry) => {
      if (!entry.startsWith('package/')) return true;
      const parts = entry.split('/').filter(Boolean);
      return parts.some((part) => part === '.' || part === '..');
    })) {
      throw new Error('release tarball contains an unsafe archive path');
    }
    await execFile('tar', ['-xzf', tarballPath, '-C', temporary]);
    const packageRoot = join(temporary, 'package');
    const inventory = await fileInventory(packageRoot);
    if (stableJson(inventory) !== stableJson(manifest.files)) throw new Error('release tarball file inventory drift');
    const metadata = await readJson(join(packageRoot, 'BUILD-METADATA.json'));
    assertSafeRelativePath(metadata.protocolRuntime?.entry, 'protocol runtime entry');
    if (metadata.protocolRuntime.entry !== 'vendor/protocol.js') throw new Error('unexpected protocol runtime entry');
    if (metadata.sourceCommit !== manifest.sourceCommit
      || metadata.protocolRuntime.version !== manifest.protocolRuntime.version
      || await sha256File(join(packageRoot, metadata.protocolRuntime.entry)) !== metadata.protocolRuntime.sha256) {
      throw new Error('bundled protocol metadata drift');
    }
    await assertReleaseSurface(packageRoot);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return manifest;
}

export async function smokeInstallRelease(outputDir = DEFAULT_OUTPUT) {
  const manifest = await verifyReleaseBundle(outputDir);
  const temporary = await mkdtemp(join(tmpdir(), 'csip-release-smoke-'));
  try {
    await writeFile(join(temporary, 'package.json'), stableJson({ private: true, type: 'module' }));
    const cache = join(temporary, 'empty-npm-cache');
    await execFile('npm', [
      'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache,
      join(outputDir, manifest.tarball.file),
    ], { cwd: temporary, maxBuffer: 10 * 1024 * 1024 });
    const modulePath = '@fortress-csip/client-core';
    const smoke = [
      `const core = await import('${modulePath}');`,
      `if (typeof core.deviceLfdi !== 'function' || typeof core.ResourceClient !== 'function') process.exit(2);`,
      `if (Object.keys(core).some((key) => /^(parse|serialize)|^Uom$/.test(key))) process.exit(3);`,
      `if (!/^[0-9a-f]{40}$/.test(core.deviceLfdi('partner', 'site'))) process.exit(4);`,
    ].join('\n');
    await execFile(process.execPath, ['--input-type=module', '--eval', smoke], { cwd: temporary });
    const requireSmoke = [
      `const core = require('${modulePath}');`,
      `if (typeof core.deviceLfdi !== 'function' || typeof core.ResourceClient !== 'function') process.exit(2);`,
      `if (!/^[0-9a-f]{40}$/.test(core.deviceLfdi('partner', 'site'))) process.exit(4);`,
    ].join('\n');
    await execFile(process.execPath, ['--eval', requireSmoke], { cwd: temporary });
    await writeFile(join(temporary, 'consumer.ts'), [
      `import { deviceLfdi, type CsipDerControlBase, type CsipTlsMaterial } from '${modulePath}';`,
      `const control: CsipDerControlBase = { opModFixedW: -500 };`,
      `const tls: CsipTlsMaterial = { certificate: new Uint8Array([1]), privateKey: new Uint8Array([1]) };`,
      `const value: string = deviceLfdi('partner', 'site');`,
      `void control; void tls; void value;`,
      '',
    ].join('\n'));
    await writeFile(join(temporary, 'tsconfig.json'), stableJson({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
      },
      files: ['consumer.ts'],
    }));
    await execFile(join(ROOT, 'node_modules/.bin/tsc'), ['--project', 'tsconfig.json'], { cwd: temporary });
    await writeFile(join(temporary, 'consumer-cjs.ts'), [
      `import { deviceLfdi, type CsipDerControlBase } from '${modulePath}';`,
      `const control: CsipDerControlBase = { opModFixedW: -500 };`,
      `const value: string = deviceLfdi('partner', 'site');`,
      `void control; void value;`,
      '',
    ].join('\n'));
    await writeFile(join(temporary, 'tsconfig-cjs.json'), stableJson({
      compilerOptions: {
        target: 'ES2018',
        module: 'CommonJS',
        moduleResolution: 'Node',
        strict: true,
        noEmit: true,
      },
      files: ['consumer-cjs.ts'],
    }));
    await execFile(join(ROOT, 'node_modules/.bin/tsc'), ['--project', 'tsconfig-cjs.json'], { cwd: temporary });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return manifest;
}

async function gitOutput(args) {
  return (await execFile('git', args, { cwd: ROOT })).stdout.trim();
}

async function assertRepositoryReady() {
  const status = await gitOutput(['status', '--porcelain', '--untracked-files=all']);
  const unexpected = status.split('\n').filter(Boolean).filter((line) => {
    const path = line.slice(3);
    return path !== '.mcp.json' && !path.startsWith('release/');
  });
  if (unexpected.length > 0) {
    throw new Error(`release requires committed source; dirty paths:\n${unexpected.join('\n')}`);
  }
  await execFile('npm', ['run', 'gen:catalog'], { cwd: ROOT });
  try {
    await execFile('git', ['diff', '--quiet', '--', 'packages/protocol/src/catalog.generated.ts'], { cwd: ROOT });
  } catch {
    throw new Error('generated protocol catalog is not committed; run npm run gen:catalog and commit it');
  }
  await execFile('npm', ['run', 'build', '--', '--force'], { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 });
}

async function main() {
  if (process.argv.includes('--verify')) {
    const manifest = await smokeInstallRelease(DEFAULT_OUTPUT);
    console.log(`verified ${manifest.tarball.file} ${manifest.tarball.sha256}`);
    return;
  }
  await assertRepositoryReady();
  const sourceCommit = await gitOutput(['rev-parse', 'HEAD']);
  const manifest = await buildReleaseBundle({ sourceCommit });
  await smokeInstallRelease(DEFAULT_OUTPUT);
  console.log(`built ${manifest.tarball.file} ${manifest.tarball.sha256}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
