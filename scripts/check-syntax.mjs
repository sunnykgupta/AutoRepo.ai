#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : path.endsWith('.mjs') ? [path] : [];
  });
}
let failed = false;
for (const file of files('scripts')) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  failed ||= result.status !== 0;
}
process.exitCode = failed ? 1 : 0;
