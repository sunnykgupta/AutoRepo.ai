#!/usr/bin/env node
import { resolve } from 'node:path';
import { validateRepository } from './lib/g1-validation.mjs';

const args = process.argv.slice(2);
let artifactMode = process.env.G1_ARTIFACT_MODE ?? (process.env.CI ? 'metadata' : 'local');
let artifactRoot = process.env.G1_ARTIFACT_ROOT;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--artifact-mode') artifactMode = args[++index];
  else if (args[index] === '--artifact-root') artifactRoot = args[++index];
  else if (args[index] === '--help') {
    console.log('Usage: node scripts/g1-validate.mjs [--artifact-mode local|metadata] [--artifact-root PATH]');
    process.exit(0);
  } else throw new Error(`Unknown argument: ${args[index]}`);
}
const errors = validateRepository(resolve('.'), { artifactMode, artifactRoot });
if (errors.length) {
  console.error(`Gate G1 validation failed (${errors.length} issue${errors.length === 1 ? '' : 's'}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Gate G1 validation passed (G0 artifact mode: ${artifactMode}).`);
}
