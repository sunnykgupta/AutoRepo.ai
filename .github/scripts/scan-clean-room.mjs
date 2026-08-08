#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const MAX_TEXT_FILE_BYTES = 1_000_000;
const archiveExtensions = /\.(?:7z|bz2|gz|iso|jar|rar|tar|tgz|xz|zip)$/i;
const prohibitedFileNames = [/^\.env(?:\.|$)/i, /\.(pem|p12|pfx|key)$/i];
const secretPatterns = [
  { category: 'private key marker', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { category: 'GitHub token', pattern: /(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}/ },
  { category: 'GitHub fine-grained token', pattern: /github_pat_[A-Za-z0-9_]{20,}/ },
  { category: 'AWS access key', pattern: /AKIA[0-9A-Z]{16}/ },
  { category: 'live secret key', pattern: /sk_live_[A-Za-z0-9]{16,}/ }
];

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

function binaryOrArchiveCategory(path, content) {
  if (archiveExtensions.test(path) || content.subarray(0, 4).equals(Buffer.from('PK\x03\x04'))) {
    return 'unsupported archive requires a dedicated scan';
  }
  if (content.includes(0)) return 'unsupported binary requires a dedicated scan';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return 'unsupported binary requires a dedicated scan';
  }
  return undefined;
}

export function scanFile(path) {
  const findings = [];
  if (prohibitedFileNames.some((pattern) => pattern.test(path)) && path !== '.env.example') {
    return [{ path, category: 'prohibited credential-bearing filename' }];
  }

  let metadata;
  let content;
  try {
    metadata = statSync(path);
    if (metadata.size > MAX_TEXT_FILE_BYTES) {
      return [{ path, category: 'oversized file requires a dedicated scan' }];
    }
    content = readFileSync(path);
  } catch {
    return [{ path, category: 'unreadable file requires a dedicated scan' }];
  }

  const unsupportedCategory = binaryOrArchiveCategory(path, content);
  if (unsupportedCategory) return [{ path, category: unsupportedCategory }];

  const text = content.toString('utf8');
  for (const { category, pattern } of secretPatterns) {
    if (pattern.test(text)) findings.push({ path, category });
  }
  return findings;
}

export function scanRepository(files = trackedFiles()) {
  return files.flatMap(scanFile);
}

function main() {
  const findings = scanRepository();
  if (findings.length > 0) {
    console.error('Clean-room/security scan failed. Do not publish finding contents in logs.');
    for (const { path, category } of findings) console.error(`- ${path}: ${category}`);
    process.exitCode = 1;
    return;
  }
  console.log('Clean-room/security scan completed with no credential-pattern findings.');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
