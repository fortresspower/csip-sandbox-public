// Public-boundary language check.
//
// This repository is public. Fortress-private service names, repository names, internal
// product vocabulary, and deployment details must not appear in it. This script is the
// regression guard for that rule: it walks the tracked text of the repository and fails on
// any forbidden term.
//
// Two tiers:
//   - `repository` terms are forbidden anywhere in the tree;
//   - `partnerFacing` terms are forbidden only on surfaces a partner reads, because the words
//     themselves ("manager", "Terraform") are legitimate elsewhere in general prose or code.
//
// The term list lives in ./public-boundary-terms.json so that this script contains none of
// the strings it forbids. That JSON file is the only path excluded from the scan.
//
// Usage:
//   node scripts/check-public-boundary.mjs             scan tracked files under the repo root
//   node scripts/check-public-boundary.mjs --root DIR  scan tracked files under DIR

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TERMS_FILE = 'scripts/public-boundary-terms.json';
const REPOSITORY_ROOT = resolve(HERE, '..');

/** Paths whose contents are not partner-readable text, or are the checker's own term data. */
const EXCLUDED_PATHS = new Set([TERMS_FILE, 'package-lock.json']);

/** Directories that hold build output, dependencies, or generated local TLS material. */
const EXCLUDED_DIRECTORIES = ['node_modules', 'dist', 'release', 'tls', '.git'];

/** Binary and archive extensions that carry no reviewable prose. */
const EXCLUDED_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.pdf',
  '.zip', '.tgz', '.gz', '.woff', '.woff2', '.ttf', '.eot',
];

/** Longest line the checker will report inline, so a minified file cannot flood the output. */
const MAX_REPORTED_LINE = 160;

export function loadTerms(termsPath = join(REPOSITORY_ROOT, TERMS_FILE)) {
  const raw = JSON.parse(readFileSync(termsPath, 'utf8'));
  const compile = (entry) => ({
    term: entry.term,
    why: entry.why,
    pattern: new RegExp(entry.regex ? entry.term : escapeRegExp(entry.term), `g${entry.flags ?? ''}`),
  });
  return {
    repository: raw.repository.map(compile),
    partnerFacing: raw.partnerFacing.map(compile),
    partnerFacingPaths: raw.partnerFacingPaths,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isPartnerFacing(relativePath, partnerFacingPaths) {
  const normalized = relativePath.split(sep).join('/');
  return partnerFacingPaths.some(
    (prefix) => normalized === prefix || normalized.startsWith(prefix),
  );
}

export function isScannablePath(relativePath) {
  const normalized = relativePath.split(sep).join('/');
  if (EXCLUDED_PATHS.has(normalized)) return false;
  if (normalized.split('/').some((segment) => EXCLUDED_DIRECTORIES.includes(segment))) return false;
  return !EXCLUDED_EXTENSIONS.some((extension) => normalized.toLowerCase().endsWith(extension));
}

/**
 * Scan one file's text. Returns a finding per matched term occurrence, each carrying the
 * file, 1-based line number, matched text, and why the term is forbidden.
 */
export function scanText(relativePath, text, terms) {
  const applicable = isPartnerFacing(relativePath, terms.partnerFacingPaths)
    ? [...terms.repository, ...terms.partnerFacing]
    : terms.repository;

  const findings = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    for (const { term, why, pattern } of applicable) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(line)) !== null) {
        findings.push({
          file: relativePath,
          line: index + 1,
          term,
          matched: match[0],
          why,
          text: line.trim().slice(0, MAX_REPORTED_LINE),
        });
        if (match[0].length === 0) pattern.lastIndex += 1;
      }
    }
  }
  return findings;
}

function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((entry) => entry.length > 0);
}

/** Scan a repository. `files` defaults to every tracked, scannable text file under `root`. */
export function checkPublicBoundary({ root = REPOSITORY_ROOT, files, terms = loadTerms() } = {}) {
  const candidates = (files ?? trackedFiles(root)).filter(isScannablePath);
  const findings = [];
  for (const relativePath of candidates) {
    let text;
    try {
      text = readFileSync(join(root, relativePath), 'utf8');
    } catch {
      continue; // deleted between listing and read, or unreadable — not a language violation
    }
    findings.push(...scanText(relativePath, text, terms));
  }
  return findings;
}

export function formatFindings(findings) {
  if (findings.length === 0) return '';
  const lines = ['Public-boundary violations found:', ''];
  for (const finding of findings) {
    lines.push(`  ${finding.file}:${finding.line}  ${finding.matched}`);
    lines.push(`    ${finding.why}`);
    lines.push(`    ${finding.text}`);
    lines.push('');
  }
  lines.push(
    `${findings.length} violation${findings.length === 1 ? '' : 's'}. ` +
      'Rewrite these in partner-observable language before committing.',
  );
  return lines.join('\n');
}

function main(argv) {
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex === -1 ? REPOSITORY_ROOT : resolve(argv[rootIndex + 1]);
  const findings = checkPublicBoundary({ root });
  if (findings.length > 0) {
    console.error(formatFindings(findings));
    return 1;
  }
  console.log('check:public-boundary: no forbidden Fortress-private language found.');
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
