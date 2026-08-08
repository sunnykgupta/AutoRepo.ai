#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import YAML from 'yaml';

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.name.endsWith('.md') ? [path] : [];
  });
}
const root = resolve('.');
const schema = JSON.parse(readFileSync(join(root, 'docs/_meta/document.schema.json'), 'utf8'));
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
const errors = [];
for (const path of files(join(root, 'docs'))) {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(readFileSync(path, 'utf8'));
  if (!match) { errors.push(`${path}: document metadata front matter is required`); continue; }
  const document = YAML.parseDocument(match[1], { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length || !validate(document.toJS())) errors.push(`${path}: metadata must satisfy docs/_meta/document.schema.json`);
}
if (errors.length) {
  console.error(`Document metadata validation failed:\n${errors.map((entry) => `- ${entry}`).join('\n')}`);
  process.exitCode = 1;
} else console.log('Document metadata validation passed.');
