#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { loadLedger } from './ledger.mjs';
import { verifyGitContext } from './git-context.mjs';

function parseNow(args) {
  const index = args.indexOf('--now');
  if (index === -1) return new Date();
  const now = new Date(args[index + 1]);
  if (Number.isNaN(now.getTime())) throw new Error('--now requires an ISO timestamp');
  return now;
}

function parseMode(args) {
  const known = new Set(['--local-ledger-only', '--now']);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!known.has(argument)) throw new Error(`Unknown argument: ${argument}`);
    if (argument === '--now') index += 1;
  }
  return { localLedgerOnly: args.includes('--local-ledger-only') };
}

function controlErrors(root) {
  const errors = [];
  const reportPath = resolve(root, 'governance/evidence/G2a-report.md');
  const report = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '';
  const requiredReportStatements = [
    'non-release and not alpha-eligible',
    'desired ruleset is not active',
    'There is no merge queue and no protected hosted gate',
    'Canonical review and check declarations are not provider proof',
    'G2A remains `PROPOSED`',
  ];
  for (const statement of requiredReportStatements) {
    if (!report.includes(statement)) {
      errors.push(`G2a report must truthfully state: ${statement}`);
    }
  }

  const workflowPath = resolve(root, '.github/workflows/governance.yml');
  const workflowText = readFileSync(workflowPath, 'utf8');
  const workflowDocument = YAML.parseDocument(workflowText, {
    prettyErrors: false,
    uniqueKeys: true,
  });
  const workflow = workflowDocument.toJS();
  const triggers = workflow?.on ?? workflow?.true;
  if (
    workflowDocument.errors.length > 0 ||
    !triggers ||
    !Object.hasOwn(triggers, 'pull_request') ||
    !Object.hasOwn(triggers, 'merge_group') ||
    !workflow.jobs?.coordination
  ) {
    errors.push('governance workflow must enforce coordination on pull_request and merge_group');
  }
  if (!workflowText.includes('run: npm run validate:governance:git')) {
    errors.push('hosted governance workflow must invoke full Git-context validation');
  }
  const checkoutRef = '${{ github.event.pull_request.head.sha || github.sha }}';
  for (const jobName of ['repository-baseline', 'coordination']) {
    const checkout = workflow.jobs?.[jobName]?.steps?.find((step) =>
      step.uses?.startsWith('actions/checkout@'),
    );
    if (checkout?.with?.ref !== checkoutRef || checkout?.with?.['fetch-depth'] !== 0) {
      errors.push(
        `${jobName} must check out the submitted pull-request head SHA or event github.sha with full history`,
      );
    }
  }
  if (/refs\/pull\/|pull\/[^\s]+\/merge/iu.test(workflowText)) {
    errors.push('governance workflow must not validate a synthetic pull-request merge ref');
  }
  return errors;
}

const root = resolve('.');
const args = process.argv.slice(2);
const now = parseNow(args);
const { localLedgerOnly } = parseMode(args);
const ledger = loadLedger(root, { now });
if (localLedgerOnly) {
  console.log('Git context not evaluated (--local-ledger-only).');
} else {
  ledger.errors.push(...verifyGitContext(root, ledger));
}
ledger.errors.push(...controlErrors(root));

if (ledger.errors.length > 0) {
  console.error(`G2a governance validation failed (${ledger.errors.length} issues):`);
  for (const error of ledger.errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`G2a governance validation passed (${ledger.items.size} canonical work items).`);
}
