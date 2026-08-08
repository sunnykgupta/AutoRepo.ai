import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve, sep } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import YAML from 'yaml';

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ROLES = new Set(['O1', 'O2', 'O3']);
const STATE_STATUSES = new Set(['not_configured', 'active']);
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function createAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat('date-time', { type: 'string', validate: (value) => ISO_TIME.test(value) });
  return ajv;
}

export function readJson(path, errors, label = path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    errors.push(`${label}: valid JSON is required (${error.message})`);
    return undefined;
  }
}

export function parseYaml(text, errors, label = 'YAML document') {
  const document = YAML.parseDocument(text, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) {
    errors.push(`${label}: valid YAML without duplicate keys is required`);
    return undefined;
  }
  const value = document.toJS();
  if (!isObject(value)) {
    errors.push(`${label}: YAML root must be an object`);
    return undefined;
  }
  return value;
}

function readYaml(path, errors, label = path) {
  if (!existsSync(path)) {
    errors.push(`${label}: required record is missing at ${path}`);
    return undefined;
  }
  return parseYaml(readFileSync(path, 'utf8'), errors, label);
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function artifactIdentity(planId, artifact) {
  return `${planId}:${artifact.name}:${artifact.sha256}`;
}

export function parseG0Record(source, errors) {
  const record = typeof source === 'string' ? parseYaml(source, errors, 'G0 record') : source;
  if (!record) return undefined;
  if (record.schema_version !== 1) errors.push('G0 record: schema_version must be 1');
  if (typeof record.record_id !== 'string' || !record.record_id) errors.push('G0 record: record_id is required');
  if (record.status !== 'APPROVED') errors.push('G0 record: status must be APPROVED');
  if (!isObject(record.platform_metadata) || !Number.isInteger(record.platform_metadata.plan_id) ||
    typeof record.platform_metadata.title !== 'string' || record.platform_metadata.approval_observed !== true) {
    errors.push('G0 record: platform plan ID, title, and approval observation are required');
  }
  const baseline = record.repository_baseline;
  if (!isObject(baseline) || typeof baseline.baseline_commit !== 'string' ||
    !SHA1.test(baseline.license_blob_sha1 ?? '') || baseline.license_spdx !== 'MIT' ||
    typeof baseline.copyright_holder !== 'string') {
    errors.push('G0 record: complete repository baseline and MIT license proof are required');
  }
  if (!isObject(record.settled_scope) || record.settled_scope.digest_algorithm !== 'sha256' ||
    !SHA256.test(record.settled_scope.digest ?? '')) {
    errors.push('G0 record: settled_scope SHA-256 digest is required');
  }
  if (!Array.isArray(record.artifacts)) errors.push('G0 record: artifacts array is required');
  else for (const artifact of record.artifacts) {
    if (!isObject(artifact) || typeof artifact.name !== 'string' || typeof artifact.kind !== 'string' ||
      typeof artifact.location !== 'string' || !SHA256.test(artifact.sha256 ?? '')) {
      errors.push('G0 record: every artifact needs name, kind, location, and SHA-256');
    }
  }
  return record;
}

export function validateG0Metadata(record, contract, errors) {
  const expected = contract.g0;
  if (!expected || !Array.isArray(expected.artifacts)) {
    errors.push('G0 record: immutable G1 artifact contract is required');
    return;
  }
  if (!expected || record.record_id !== expected.record_id || record.platform_metadata?.plan_id !== expected.plan_id ||
    record.plan_title !== expected.plan_title || record.platform_metadata?.title !== expected.plan_title ||
    record.platform_metadata?.approval_observed !== true ||
    record.repository_baseline?.baseline_commit !== expected.baseline_commit) {
    errors.push('G0 record: immutable platform plan, approval observation, and baseline metadata do not match G1 contract');
  }
  const actual = record.artifacts ?? [];
  if (actual.length !== expected.artifacts.length) {
    errors.push(`G0 record: exactly ${expected.artifacts.length} approved artifacts are required`);
    return;
  }
  const expectedIdentities = new Set(expected.artifacts.map((artifact) => artifactIdentity(expected.plan_id, artifact)));
  const actualIdentities = new Set(actual.map((artifact) => artifactIdentity(record.platform_metadata?.plan_id, artifact)));
  if (actualIdentities.size !== actual.length || actualIdentities.size !== expectedIdentities.size ||
    [...actualIdentities].some((identity) => !expectedIdentities.has(identity)) ||
    actual.some((artifact) => expected.artifacts.find((expectedArtifact) =>
      artifactIdentity(expected.plan_id, expectedArtifact) === artifactIdentity(record.platform_metadata?.plan_id, artifact))?.kind !== artifact.kind)) {
    errors.push('G0 record: artifact identities must exactly match approved plan ID, attachment name, kind, and SHA-256');
  }
}

export function validateG0Artifacts(record, artifactMode, artifactRoot, errors) {
  if (artifactMode === 'metadata') return;
  if (artifactMode !== 'local') {
    errors.push(`G0 artifacts: unsupported mode "${artifactMode}"`);
    return;
  }
  if (!artifactRoot) {
    errors.push('G0 artifacts: local mode requires G1_ARTIFACT_ROOT or --artifact-root');
    return;
  }
  const root = resolve(artifactRoot);
  for (const artifact of record.artifacts ?? []) {
    const artifactPath = resolve(root, relative('/code/.plans', artifact.location));
    if (!artifactPath.startsWith(`${root}${sep}`) || !existsSync(artifactPath)) {
      errors.push(`G0 artifact ${artifact.name}: external hash proof is unavailable`);
      continue;
    }
    if (hash(readFileSync(artifactPath)) !== artifact.sha256) {
      errors.push(`G0 artifact ${artifact.name}: SHA-256 does not match record`);
    }
  }
}

export function validateG0History(root, record, contract, errors) {
  const baseline = record.repository_baseline?.baseline_commit;
  if (!baseline || !git(root, ['rev-parse', '--verify', `${baseline}^{commit}`])) {
    errors.push('G0 history: recorded baseline commit is unavailable');
    return;
  }
  const baselineBlob = git(root, ['rev-parse', `${baseline}:LICENSE`]);
  if (baselineBlob !== record.repository_baseline.license_blob_sha1) errors.push('G0 history: baseline LICENSE blob does not match record');
  const roots = git(root, ['rev-list', '--max-parents=0', baseline])?.split('\n') ?? [];
  if (!roots.includes(git(root, ['rev-parse', baseline]))) errors.push('G0 history: baseline must be a root commit');
  const baselinePaths = git(root, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', baseline]);
  if (baselinePaths !== 'LICENSE') errors.push('G0 history: baseline commit must introduce only LICENSE');
  const descendants = git(root, ['rev-list', '--reverse', `${baseline}..HEAD`])?.split('\n').filter(Boolean) ?? [];
  if (!descendants.length) {
    errors.push('G0 history: approval record must be the first post-baseline commit');
    return;
  }
  const firstPaths = git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', descendants[0]])?.split('\n') ?? [];
  if (firstPaths.length !== 1 || firstPaths[0] !== 'governance/approvals/G0-v2.yaml') {
    errors.push('G0 history: first post-baseline commit must contain only the G0 approval record');
  }
  if (record.repository_baseline.baseline_commit !== contract.g0.baseline_commit) {
    errors.push('G0 history: baseline does not match immutable G1 contract');
  }
}

export function validateLicense(root, record, errors) {
  const licensePath = join(root, 'LICENSE');
  if (!existsSync(licensePath)) {
    errors.push('LICENSE: required MIT LICENSE file is missing');
    return;
  }
  const license = readFileSync(licensePath, 'utf8');
  const baseline = record.repository_baseline;
  if (!license.startsWith('MIT License\n\n') ||
    !license.includes('Permission is hereby granted, free of charge, to any person obtaining a copy') ||
    !license.includes('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND')) {
    errors.push('LICENSE: SPDX content must be the MIT license');
  }
  if (!license.includes(`Copyright (c) 2026 ${baseline.copyright_holder}`)) {
    errors.push('LICENSE: copyright holder does not match G0 record');
  }
  if (git(root, ['hash-object', 'LICENSE']) !== baseline.license_blob_sha1) {
    errors.push('LICENSE: current blob differs from the approved baseline');
  }
}

export function validateToolchain(root, errors) {
  const pkg = readJson(join(root, 'package.json'), errors, 'package.json');
  if (!pkg) return;
  if (pkg.packageManager !== 'npm@11.19.0') errors.push('package.json: packageManager must be npm@11.19.0');
  if (pkg.engines?.node !== '24.19.0' || pkg.engines?.npm !== '11.19.0') {
    errors.push('package.json: engines.node and engines.npm must be exact 24.19.0 and 11.19.0');
  }
  if (!existsSync(join(root, '.nvmrc')) || readFileSync(join(root, '.nvmrc'), 'utf8').trim() !== '24.19.0') {
    errors.push('.nvmrc: must be exactly 24.19.0');
  }
}

function workspacePatterns(workspaces) {
  return Array.isArray(workspaces) ? workspaces : workspaces?.packages ?? [];
}

function packageFilesForPattern(root, pattern) {
  if (typeof pattern !== 'string') return [];
  if (!pattern.endsWith('/*')) return [join(root, pattern, 'package.json')];
  const parent = join(root, pattern.slice(0, -2));
  if (!existsSync(parent)) return [];
  return readdirSync(parent).map((entry) => join(parent, entry, 'package.json')).filter(existsSync);
}

export function validateWorkspaceNamespace(root, policy, errors) {
  const packagePolicy = readYaml(join(root, policy.package_policy), errors, 'package namespace policy');
  const pkg = readJson(join(root, 'package.json'), errors, 'package.json');
  if (!packagePolicy || !pkg) return;
  if (packagePolicy.schema_version !== 1 || typeof packagePolicy.package_name_pattern !== 'string') {
    errors.push('package namespace policy: schema_version and package_name_pattern are required');
    return;
  }
  let matcher;
  try { matcher = new RegExp(packagePolicy.package_name_pattern); } catch { errors.push('package namespace policy: invalid package_name_pattern'); return; }
  const files = [join(root, 'package.json')];
  for (const pattern of workspacePatterns(pkg.workspaces)) files.push(...packageFilesForPattern(root, pattern));
  for (const file of [...new Set(files)]) {
    const workspace = readJson(file, errors, relative(root, file));
    if (workspace && (typeof workspace.name !== 'string' || !matcher.test(workspace.name))) {
      errors.push(`${relative(root, file)}: package name must match governance/packages.yaml`);
    }
  }
}

function schemaErrors(validate) {
  return validate.errors?.map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ') ?? 'unknown schema error';
}

export function validateAuthority(root, policy, errors) {
  const record = readYaml(join(root, policy.authority_record), errors, 'authority record');
  const schema = readJson(join(root, policy.owners_schema), errors, 'authority schema');
  if (!record || !schema) return;
  const ajv = createAjv();
  const validate = ajv.compile(schema);
  if (!validate(record)) {
    errors.push(`authority record: fails governance/owners.schema.json (${schemaErrors(validate)})`);
    return;
  }
  const byId = new Map(record.authorities.map((authority) => [authority.id, authority]));
  if (byId.size !== 3 || [...ROLES].some((role) => !byId.has(role))) errors.push('authority record: O1, O2, and O3 must be distinct records');
  if (new Set(record.authorities.map((authority) => authority.record_id)).size !== record.authorities.length) {
    errors.push('authority record: O1, O2, and O3 must have distinct record_id values');
  }
  for (const role of ['O1', 'O2']) {
    const holder = byId.get(role)?.holder;
    if (!isObject(holder) || !holder.name || !holder.github) errors.push(`authority record: ${role} requires a named human holder`);
  }
  const o3 = byId.get('O3');
  if (o3?.status !== 'inactive' || o3.holder !== null) errors.push('authority record: O3 must remain inactive without a holder');
  const o2Restrictions = byId.get('O2')?.restrictions ?? [];
  if (!o2Restrictions.some((restriction) => /second independent human reviewer/i.test(restriction))) {
    errors.push('authority record: security exceptions require a second independent human');
  }
  for (const exception of record.security_exceptions) {
    if (exception.status !== 'approved') continue;
    const requester = Object.values(record.principals).find((principal) => principal.principal_id === exception.requested_by);
    const approver = Object.values(record.principals).find((principal) => principal.principal_id === exception.approved_by);
    if (exception.requested_by === exception.approved_by || requester?.type !== 'human' || approver?.type !== 'human' ||
      requester?.active !== true || approver?.active !== true || exception.independent_human_approval !== true) {
      errors.push('authority record: approved security exceptions require a second active human');
    }
  }
}

export function validateCleanRoom(root, policy, contracts, errors) {
  const record = readYaml(join(root, policy.clean_room_attestation), errors, 'clean-room attestation');
  const schema = readJson(join(root, policy.clean_room_schema), errors, 'clean-room attestation schema');
  if (!record || !schema) return;
  const ajv = createAjv();
  const validate = ajv.compile(schema);
  if (!validate(record)) {
    errors.push(`clean-room attestation: fails declared JSON schema (${schemaErrors(validate)})`);
    return;
  }
  const expected = contracts.clean_room_attestation;
  if (!isObject(expected)) {
    errors.push('clean-room attestation: immutable G1 contract is required');
    return;
  }
  const inventory = record.restricted_inventory;
  const evidence = record.immutable_external_evidence;
  if (record.schema_version !== 1 || record.policy_version !== expected.policy_version ||
    record.attestation?.id !== expected.attestation_id || record.attestation?.status !== expected.attestation_status ||
    record.attestation?.result !== expected.result ||
    !ISO_TIME.test(record.attestation?.recorded_at ?? '') || !isObject(inventory) ||
    inventory.digest_algorithm !== 'sha256' || !SHA256.test(inventory.digest ?? '') ||
    inventory.digest !== expected.restricted_inventory_digest ||
    inventory.entry_count !== expected.restricted_inventory_entry_count || !isObject(evidence) ||
    evidence.status !== expected.evidence_status || !SHA256.test(evidence.restricted_scan_report_sha256 ?? '') ||
    !SHA256.test(evidence.restricted_tool_manifest_sha256 ?? '')) {
    errors.push('clean-room attestation: exact policy, inventory digest/count, passing result, and immutable tool/report hash metadata are required');
  }
}

export function validateCommunitySecurity(root, policy, errors) {
  const path = join(root, policy.community_security_state);
  const record = readJson(path, errors, 'community/security state');
  if (!record) return;
  for (const section of ['community', 'security']) {
    if (record.schema_version !== 1 || !isObject(record[section]) || !STATE_STATUSES.has(record[section].status)) {
      errors.push(`community/security state: ${section}.status must be not_configured or active`);
    }
  }
}

export function validateSettingsEvidence(root, policy, contracts, errors) {
  const record = readJson(join(root, policy.settings_evidence), errors, 'repository settings evidence');
  if (!record) return;
  if (record.schema_version !== 1 || !ISO_TIME.test(record.observed_at ?? '') || !isObject(record.desired) ||
    !isObject(record.live?.settings) || !isObject(record.comparison?.settings)) {
    errors.push('repository settings evidence: desired, timestamped live settings, and per-setting comparison are required');
    return;
  }
  const allowed = new Set(contracts.settings_evidence.allowed_setting_statuses);
  for (const [name, desired] of Object.entries(record.desired)) {
    const comparison = record.comparison.settings[name];
    if (!isObject(comparison) || !allowed.has(comparison.status)) {
      errors.push(`repository settings evidence: ${name} requires matched or deferred status`);
    } else if (comparison.status === 'matched' && record.live.settings[name] !== desired) {
      errors.push(`repository settings evidence: matched setting ${name} differs from desired`);
    } else if ((comparison.status === 'deferred' || comparison.status === 'authorized_deferred') &&
      (typeof comparison.reason !== 'string' || !comparison.reason.trim())) {
      if (comparison.status !== 'authorized_deferred' || typeof comparison.desired_contract !== 'string' || !comparison.desired_contract) {
        errors.push(`repository settings evidence: deferred setting ${name} requires a reason or desired contract`);
      }
    }
  }
  for (const name of Object.keys(record.comparison.settings)) {
    if (!(name in record.desired)) errors.push(`repository settings evidence: comparison contains undesired setting ${name}`);
  }
}

function normalizeTriggers(value) {
  if (typeof value === 'string') return new Set([value]);
  if (Array.isArray(value)) return new Set(value.filter((trigger) => typeof trigger === 'string'));
  if (isObject(value)) return new Set(Object.keys(value));
  return new Set();
}

function collectUses(value, uses = []) {
  if (Array.isArray(value)) for (const child of value) collectUses(child, uses);
  else if (isObject(value)) for (const [key, child] of Object.entries(value)) {
    if (key === 'uses' && typeof child === 'string') uses.push(child);
    collectUses(child, uses);
  }
  return uses;
}

function containsSecrets(value) {
  if (typeof value === 'string') return /\bsecrets\s*\./i.test(value);
  if (Array.isArray(value)) return value.some(containsSecrets);
  return isObject(value) && Object.values(value).some(containsSecrets);
}

function normalizePermissions(value) {
  if (typeof value === 'string') return { scalar: value, entries: {} };
  return { scalar: undefined, entries: isObject(value) ? value : {} };
}

function mayRunOnPullRequest(job) {
  const condition = job?.if;
  return typeof condition !== 'string' || !(/github\.event_name\s*!=\s*['"]pull_request['"]/.test(condition) ||
    /github\.event_name\s*==\s*['"](?:push|schedule|workflow_dispatch)['"]/.test(condition));
}

function permissionErrors(value, label, allowTrustedSecurityWrites) {
  const permissions = normalizePermissions(value);
  if (!value) return [`${label}: explicit top-level least-privilege permissions are required`];
  if (permissions.scalar) return permissions.scalar === 'read-all' ? [] : [`${label}: permissions scalar must be read-all`];
  const errors = [];
  if (permissions.entries.contents !== 'read') errors.push(`${label}: permissions must set contents: read`);
  for (const [scope, level] of Object.entries(permissions.entries)) {
    if (level === 'write' && !(allowTrustedSecurityWrites && ['id-token', 'security-events'].includes(scope))) {
      errors.push(`${label}: ${scope} permission must not exceed read`);
    } else if (!['read', 'none', 'write'].includes(level)) errors.push(`${label}: ${scope} permission is invalid`);
  }
  return errors;
}

export function parseWorkflow(text, label = 'workflow') {
  const errors = [];
  const workflow = parseYaml(text, errors, label);
  if (!workflow) return { errors, workflow: undefined, triggers: new Set(), uses: [] };
  const triggerValue = workflow.on ?? workflow.true;
  return { errors, workflow, triggers: normalizeTriggers(triggerValue), uses: collectUses(workflow) };
}

export function validateWorkflowDocument(text, label = 'workflow') {
  const parsed = parseWorkflow(text, label);
  const errors = [...parsed.errors];
  if (!parsed.workflow) return errors;
  const hasPullRequest = parsed.triggers.has('pull_request');
  if (parsed.triggers.has('pull_request_target')) errors.push(`${label}: pull_request_target is forbidden`);
  errors.push(...permissionErrors(parsed.workflow.permissions, label, !hasPullRequest));
  if (isObject(parsed.workflow.jobs)) {
    for (const [name, job] of Object.entries(parsed.workflow.jobs)) {
      if (isObject(job) && job.permissions) {
        errors.push(...permissionErrors(job.permissions, `${label}: job ${name}`, !(hasPullRequest && mayRunOnPullRequest(job))));
      }
    }
  }
  if (hasPullRequest && containsSecrets(parsed.workflow)) errors.push(`${label}: pull_request workflows must not access secrets`);
  for (const action of parsed.uses) {
    if (!action.startsWith('./') && !/^(?:[\w.-]+\/)+[\w.-]+@[a-f0-9]{40}$/i.test(action)) {
      errors.push(`${label}: action ${action} must be pinned to a full 40-character SHA`);
    }
  }
  return errors;
}

export function validateWorkflows(root, policy, errors) {
  const directory = join(root, policy.workflow_directory);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    errors.push(`workflow policy: workflow directory is missing at ${policy.workflow_directory}`);
    return;
  }
  const workflows = readdirSync(directory).filter((file) => /\.ya?ml$/i.test(file));
  if (!workflows.length) errors.push('workflow policy: at least one workflow is required');
  for (const file of workflows) errors.push(...validateWorkflowDocument(readFileSync(join(directory, file), 'utf8'), `${policy.workflow_directory}/${file}`));
}

export function validateRepository(root, options = {}) {
  const errors = [];
  const policy = readJson(join(root, 'config/g1-policy.json'), errors, 'G1 policy');
  const contracts = readJson(join(root, 'config/g1-record-contracts.json'), errors, 'G1 record contracts');
  validateToolchain(root, errors);
  if (!policy || policy.schema_version !== 1 || !contracts || contracts.schema_version !== 1) {
    errors.push('G1 policy and record contracts must use schema_version 1');
    return errors;
  }
  validateWorkspaceNamespace(root, policy, errors);
  const g0Path = join(root, policy.g0_approval_record);
  if (!existsSync(g0Path)) errors.push(`G0 record: missing at ${policy.g0_approval_record}`);
  else {
    const record = parseG0Record(readFileSync(g0Path, 'utf8'), errors);
    if (record) {
      validateG0Metadata(record, contracts, errors);
      validateG0Artifacts(record, options.artifactMode ?? (process.env.CI ? 'metadata' : 'local'), options.artifactRoot, errors);
      validateG0History(root, record, contracts, errors);
      validateLicense(root, record, errors);
    }
  }
  validateAuthority(root, policy, errors);
  validateCleanRoom(root, policy, contracts, errors);
  validateCommunitySecurity(root, policy, errors);
  validateSettingsEvidence(root, policy, contracts, errors);
  validateWorkflows(root, policy, errors);
  return errors;
}
