#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.(?:mjs|json)$/u.test(path) ? [path] : [];
  });
}
const targets = [...files('scripts'), ...files('config'), 'package.json'];
const problems = [];
for (const file of targets) {
  const text = readFileSync(file, 'utf8');
  if (!text.endsWith('\n')) problems.push(`${file}: file must end with a newline`);
  if (/[ \t]+$/mu.test(text.replace(/\n$/u, ''))) problems.push(`${file}: trailing whitespace is not allowed`);
  if (file.endsWith('.json')) {
    try { JSON.parse(text); } catch (error) { problems.push(`${file}: invalid JSON (${error.message})`); }
  }
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
}
