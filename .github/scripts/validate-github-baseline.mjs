#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseWorkflow, validateWorkflowDocument } from '../../scripts/lib/g1-validation.mjs';

const SHA_PIN = /^[^\s@]+@[0-9a-f]{40}$/i;

export function parseWorkflowYaml(text) {
  const parsed = parseWorkflow(text, 'workflow');
  if (!parsed.workflow) throw new Error(parsed.errors.join('; '));
  return parsed.workflow;
}

function hasTrigger(document, trigger) {
  const triggers = document?.on ?? document?.true;
  if (typeof triggers === 'string') return triggers === trigger;
  if (Array.isArray(triggers)) return triggers.includes(trigger);
  return triggers !== null && typeof triggers === 'object' && Object.hasOwn(triggers, trigger);
}

function actionReferences(value, references = []) {
  if (Array.isArray(value)) {
    for (const entry of value) actionReferences(entry, references);
  } else if (value !== null && typeof value === 'object') {
    if (typeof value.uses === 'string') references.push(value.uses);
    for (const entry of Object.values(value)) actionReferences(entry, references);
  }
  return references;
}

function jobCanRunOnPullRequest(job) {
  if (typeof job?.if !== 'string') return true;
  if (/github\.event_name\s*!=\s*'pull_request'/.test(job.if)) return false;
  if (/github\.event_name\s*==\s*'pull_request'/.test(job.if)) return true;
  return true;
}

function pullRequestPermissionValues(document) {
  const values = [document.permissions];
  for (const job of Object.values(document.jobs ?? {})) {
    if (jobCanRunOnPullRequest(job) && Object.hasOwn(job, 'permissions')) values.push(job.permissions);
  }
  return values;
}

function sourceHasVersionComment(text, action) {
  const escapedAction = action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*(?:-\\s*)?uses:\\s*${escapedAction}\\s+#\\s+v[\\w.-]+\\s*$`, 'm').test(text);
}

function isReadOnlyContents(permissions) {
  return permissions !== null && typeof permissions === 'object' && !Array.isArray(permissions) &&
    Object.keys(permissions).length === 1 && permissions.contents === 'read';
}

function hasWritePermission(permissions) {
  if (typeof permissions === 'string') return permissions === 'write-all';
  return permissions !== null && typeof permissions === 'object' &&
    Object.values(permissions).some((value) => value === 'write');
}

function trustedOnlyWritePermissions(document) {
  return Object.values(document.jobs ?? {}).every((job) => !Object.hasOwn(job, 'permissions') ||
    !hasWritePermission(job.permissions) || !jobCanRunOnPullRequest(job));
}

export function findUnpinnedActionLines(text) {
  const document = parseWorkflowYaml(text);
  return actionReferences(document).filter((action) => !SHA_PIN.test(action) || !sourceHasVersionComment(text, action));
}

export function findPullRequestSafetyViolations(text) {
  const document = parseWorkflowYaml(text);
  const violations = [];
  if (hasTrigger(document, 'pull_request_target')) violations.push('must not use pull_request_target');
  if (!hasTrigger(document, 'pull_request')) return violations;
  if (!isReadOnlyContents(document.permissions)) violations.push('must set top-level contents: read permissions');
  if (pullRequestPermissionValues(document).some(hasWritePermission)) violations.push('must not request write permissions');
  if (/\$\{\{\s*secrets\./.test(text)) violations.push('must not reference secrets');
  return violations;
}

function sharedWorkflowErrors(text, label, document) {
  return validateWorkflowDocument(text, label).filter((error) => {
    // Root G1 validation correctly forbids write tokens in baseline workflows. The
    // trusted-only CodeQL/Scorecard uploads are intentionally outside pull_request.
    if (document && trustedOnlyWritePermissions(document) && /permission must not exceed read$/.test(error)) return false;
    // The root policy validator currently validates owner/repository action syntax;
    // this wrapper additionally accepts action subpaths (such as CodeQL init) and
    // requires their source-line version comments.
    return !/action .* must be pinned to a full 40-character SHA$/.test(error);
  });
}

export async function validateBaseline(repoRoot = process.cwd()) {
  const errors = [];
  const codeowners = await readFile(resolve(repoRoot, '.github/CODEOWNERS'), 'utf8');
  if (!codeowners.includes('* @sunnykgupta')) errors.push('CODEOWNERS must assign the bootstrap principal.');

  const ruleset = JSON.parse(await readFile(resolve(repoRoot, '.github/rulesets/main.json'), 'utf8'));
  if (ruleset.contract_status !== 'desired-only') errors.push('Main ruleset must be labeled desired-only.');
  if (!ruleset.conditions?.ref_name?.include?.includes('refs/heads/main')) {
    errors.push('Main ruleset must target refs/heads/main.');
  }

  const requiredContexts = new Set(ruleset.rules.find((rule) => rule.type === 'required_status_checks')
    ?.parameters?.required_status_checks?.map(({ context }) => context) ?? []);
  for (const context of ['ci / node', 'governance / repository-baseline', 'clean-room / policy', 'security / dependency-and-secret-audit']) {
    if (!requiredContexts.has(context)) errors.push(`Main ruleset must require ${context}.`);
  }

  const verified = JSON.parse(await readFile(resolve(repoRoot, '.github/settings/verified-live.json'), 'utf8'));
  const honestSettingsEvidence = verified.verification_status === 'partially-verified' &&
    verified.settings_mutation_performed_by_this_change === false &&
    verified.authorization_status === 'authorized-deferred' &&
    verified.desired?.main_ruleset?.name === ruleset.name &&
    verified.desired?.release_environment?.name === 'release' &&
    verified.observed?.main_rulesets?.count === 0 &&
    verified.observed?.main_rulesets?.status === 'authorized-deferred' &&
    verified.observed?.release_environments?.count === 0 &&
    verified.observed?.release_environments?.status === 'authorized-deferred' &&
    verified.observed?.private_vulnerability_reporting?.enabled === true &&
    verified.observed?.private_vulnerability_reporting?.status === 'matched';
  if (!honestSettingsEvidence) {
    errors.push('Live settings evidence must distinguish desired ruleset/environment from deferred zero-count observations and matched PVR.');
  }

  const workflowDirectory = resolve(repoRoot, '.github/workflows');
  for (const name of await readdir(workflowDirectory)) {
    if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue;
    const workflow = await readFile(resolve(workflowDirectory, name), 'utf8');
    try {
      const document = parseWorkflowYaml(workflow);
      for (const action of findUnpinnedActionLines(workflow)) {
        errors.push(`${name}: action is not SHA-pinned with a version comment: ${action}`);
      }
      for (const violation of findPullRequestSafetyViolations(workflow)) {
        errors.push(`${name}: pull_request workflow ${violation}.`);
      }
      errors.push(...sharedWorkflowErrors(workflow, `.github/workflows/${name}`, document));
    } catch (error) {
      errors.push(`${name}: ${error.message}`);
    }
  }
  return errors;
}

async function main() {
  const errors = await validateBaseline();
  if (errors.length > 0) {
    console.error('GitHub baseline validation failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log('GitHub baseline validation passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
