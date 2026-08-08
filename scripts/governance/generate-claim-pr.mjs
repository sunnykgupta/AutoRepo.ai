#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadLedger, renderClaimPullRequest } from './ledger.mjs';

function value(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1 || !args[index + 1]) throw new Error(`${flag} is required`);
  return args[index + 1];
}
function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node scripts/governance/generate-claim-pr.mjs --item ID --output FILE (renders an existing CLAIM_REQUEST)');
    return;
  }
  const ledger = loadLedger(resolve('.'));
  if (ledger.errors.length) throw new Error(`Canonical ledger is invalid:\n${ledger.errors.join('\n')}`);
  const id = value(args, '--item'); const output = value(args, '--output');
  const record = ledger.records.find((entry) => entry.item.id === id);
  if (!record) throw new Error(`Unknown canonical work item: ${id}`);
  const request = record.events.find((event) => event.type === 'CLAIM_REQUEST')?.request;
  if (!request) throw new Error(`${id} has no canonical CLAIM_REQUEST; an artifact cannot create ownership`);
  writeFileSync(resolve(output), renderClaimPullRequest(record.item, request));
  console.log(`Wrote claim-request pull-request artifact for ${id}.`);
}
main();
