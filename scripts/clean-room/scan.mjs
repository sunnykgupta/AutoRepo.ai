#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const ARCHIVE_EXTENSIONS = new Set(['.7z', '.bz2', '.gz', '.rar', '.tar', '.tgz', '.xz', '.zip']);
const TEXT_EXTENSIONS = new Set(['.cjs', '.css', '.csv', '.html', '.js', '.json', '.md', '.mjs', '.mts', '.sh', '.svg', '.toml', '.ts', '.tsx', '.txt', '.yaml', '.yml']);
const TEXT_BASENAMES = new Set(['.gitignore', '.npmrc', '.nvmrc', '.prettierignore', 'CODEOWNERS', 'LICENSE']);
const SKIPPED_DIRECTORIES = new Set(['.git', 'coverage', 'node_modules']);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(message) {
  throw new Error(`clean-room scan failed: ${message}`);
}

function readManifest(path) {
  if (!path) fail('an external confidential corpus manifest is required');
  let manifest;
  try { manifest = JSON.parse(readFileSync(path, 'utf8')); } catch { fail('external confidential corpus proof is unavailable'); }
  if (manifest.schema_version !== 1 || !SHA256.test(manifest.restricted_inventory_digest ?? '') ||
    !Number.isSafeInteger(manifest.entry_count) || manifest.entry_count < 1 ||
    !Array.isArray(manifest.prohibited_identifiers) || !Array.isArray(manifest.prohibited_file_hashes) ||
    manifest.prohibited_identifiers.some((identifier) => typeof identifier !== 'string' || !identifier) ||
    manifest.prohibited_file_hashes.some((value) => !SHA256.test(value))) {
    fail('external confidential corpus proof has an invalid schema');
  }
  return manifest;
}

function publicFiles(root, outputPath) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (resolve(path) === resolve(outputPath)) continue;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) files.push(...publicFiles(path, outputPath));
    } else if (entry.isFile()) files.push(path);
    else fail('unrecognized filesystem entry');
  }
  return files;
}

function finding(code, path) {
  return { code, fingerprint: sha256(`${code}\0${relative(process.cwd(), path)}`) };
}

export function scanCleanRoom({ publicRoot = process.cwd(), confidentialCorpusManifest, reportPath, maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
  const manifest = readManifest(confidentialCorpusManifest);
  if (!reportPath) fail('a hash-only report path is required');
  const root = resolve(publicRoot);
  if (!statSync(root).isDirectory()) fail('public scan root is unavailable');
  const prohibitedHashes = new Set(manifest.prohibited_file_hashes);
  const findings = [];
  for (const path of publicFiles(root, reportPath)) {
    const info = statSync(path);
    const extension = extname(path).toLowerCase();
    if (ARCHIVE_EXTENSIONS.has(extension)) {
      findings.push(finding('archive-file', path));
      continue;
    }
    if (info.size > maxFileBytes) {
      findings.push(finding('oversized-file', path));
      continue;
    }
    const content = readFileSync(path);
    const contentHash = sha256(content);
    if (prohibitedHashes.has(contentHash)) findings.push(finding('prohibited-file-hash', path));
    if ((!TEXT_EXTENSIONS.has(extension) && !TEXT_BASENAMES.has(basename(path))) || content.includes(0)) {
      findings.push(finding('unrecognized-or-binary-file', path));
      continue;
    }
    const text = content.toString('utf8');
    if (manifest.prohibited_identifiers.some((identifier) => text.includes(identifier))) {
      findings.push(finding('prohibited-identifier', path));
    }
  }
  const report = {
    schema_version: 1,
    tool: '@autorepo/clean-room-scan',
    report_format: 'hash-only-v1',
    restricted_inventory_digest: manifest.restricted_inventory_digest,
    restricted_inventory_entry_count: manifest.entry_count,
    scanned_public_file_count: publicFiles(root, reportPath).length,
    finding_count: findings.length,
    finding_fingerprints: findings.map((entry) => entry.fingerprint).sort(),
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return { findings, report };
}

function cli() {
  const args = process.argv.slice(2);
  const options = { publicRoot: process.cwd() };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--confidential-corpus-manifest') options.confidentialCorpusManifest = args[++index];
    else if (args[index] === '--report') options.reportPath = args[++index];
    else if (args[index] === '--public-root') options.publicRoot = args[++index];
    else if (args[index] === '--help') {
      console.log('Usage: scan.mjs --confidential-corpus-manifest PATH --report PATH [--public-root PATH]');
      return 0;
    } else fail(`unknown argument ${basename(args[index])}`);
  }
  const { findings, report } = scanCleanRoom(options);
  // Deliberately report counts and digests only; never disclose corpus values or public match content.
  console.log(`Clean-room scan completed: ${report.scanned_public_file_count} files, ${findings.length} findings.`);
  return findings.length === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.exitCode = cli(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
