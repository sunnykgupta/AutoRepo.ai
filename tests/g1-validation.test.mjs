import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  parseG0Record,
  parseYaml,
  validateAuthority,
  validateCleanRoom,
  validateG0History,
  validateG0Metadata,
  validateSquashAmendment,
  validateSettingsEvidence,
  validateWorkflowDocument,
  validateWorkflows,
  validateWorkspaceNamespace,
} from '../scripts/lib/g1-validation.mjs';
import { scanCleanRoom } from '../scripts/clean-room/scan.mjs';

const root = process.cwd();
const policy = JSON.parse(readFileSync(join(root, 'config/g1-policy.json')));
const contracts = JSON.parse(readFileSync(join(root, 'config/g1-record-contracts.json')));

function write(path, content) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function temporaryRoot() {
  const path = mkdtempSync(join(tmpdir(), 'autorepo-g1-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

test('parses G0 with a real YAML parser and verifies immutable metadata and history', () => {
  const errors = [];
  const record = parseG0Record(readFileSync(join(root, policy.g0_approval_record), 'utf8'), errors);
  validateG0Metadata(record, contracts, errors);
  validateG0History(root, record, contracts, errors);
  assert.deepEqual(errors, []);
  const wrongKind = structuredClone(record);
  wrongKind.artifacts[0].kind = 'unexpected';
  const metadataErrors = [];
  validateG0Metadata(wrongKind, contracts, metadataErrors);
  assert.match(metadataErrors.join('\n'), /artifact identities/);
});

test('rejects every material squash-amendment identity mutation', () => {
  const expected = contracts.g0.squash_amendment;
  const amendmentPath = join(root, expected.path);
  const original = readFileSync(amendmentPath, 'utf8');
  const mutations = [
    ['wrong merge SHA', expected.squash_merge_commit, '0'.repeat(40)],
    ['wrong squash tree', expected.squash_tree, '1'.repeat(40)],
    ['wrong candidate commit', expected.candidate_commit, '2'.repeat(40)],
    ['wrong candidate tree', expected.candidate_tree, '3'.repeat(40)],
    ['wrong decision ID', '  - id: 41', '  - id: 99'],
    ['wrong amendment status', 'status: "APPROVED"', 'status: "REJECTED"'],
    ['wrong source baseline parent', expected.source_baseline_commit, '4'.repeat(40)],
  ];
  for (const [label, before, after] of mutations) {
    const raw = Buffer.from(original.replace(before, after));
    assert.notEqual(raw.toString(), original, `${label} fixture must alter the amendment`);
    const errors = [];
    const amendment = parseYaml(raw.toString('utf8'), errors, label);
    validateSquashAmendment(root, amendment, raw, expected, errors);
    assert.ok(errors.length > 0, `${label} must be rejected`);
  }
});

test('rejects unknown squash-amendment fields and approval-record mutations', () => {
  const expected = contracts.g0.squash_amendment;
  const original = readFileSync(join(root, expected.path), 'utf8');
  for (const [label, raw] of [
    ['unknown field', Buffer.from(`${original}unexpected: true\n`)],
    ['approval blob', Buffer.from(original.replace(expected.approval_record_blob, '5'.repeat(40)))],
    ['approval digest', Buffer.from(original.replace(expected.approval_record_sha256, '6'.repeat(64)))],
    ['approver identity', Buffer.from(original.replace('github_login: "sunnykgupta"', 'github_login: "someone-else"'))],
  ]) {
    const errors = [];
    const amendment = parseYaml(raw.toString('utf8'), errors, label);
    validateSquashAmendment(root, amendment, raw, expected, errors);
    assert.ok(errors.length > 0, `${label} must be rejected`);
  }
});

test('rejects duplicate YAML keys instead of silently accepting an overridden owner', () => {
  const errors = [];
  assert.equal(parseYaml('schema_version: 1\nschema_version: 2\n', errors, 'owners fixture'), undefined);
  assert.deepEqual(errors, ['owners fixture: valid YAML without duplicate keys is required']);
});

test('validates the checked-in authority YAML against its JSON schema and bootstrap constraints', () => {
  const errors = [];
  validateAuthority(root, policy, errors);
  assert.deepEqual(errors, []);
});

test('rejects approved security exceptions that reuse the requester as approver', () => {
  const setup = temporaryRoot();
  try {
    write(join(setup.path, 'governance/owners.yaml'), readFileSync(join(root, 'governance/owners.yaml')));
    write(join(setup.path, 'governance/owners.schema.json'), readFileSync(join(root, 'governance/owners.schema.json')));
    const ownersPath = join(setup.path, 'governance/owners.yaml');
    const owners = readFileSync(ownersPath, 'utf8').replace('security_exceptions: []', `security_exceptions:
  - exception_id: "security-exception:invalid-self-approval"
    status: "approved"
    requested_by: "principal:sunny-r-gupta"
    approved_by: "principal:sunny-r-gupta"
    independent_human_approval: true
    decision_record: "test"
`);
    write(ownersPath, owners);
    const errors = [];
    validateAuthority(setup.path, {
      authority_record: 'governance/owners.yaml', owners_schema: 'governance/owners.schema.json',
    }, errors);
    assert.match(errors.join('\n'), /second active human/);
  } finally {
    setup.cleanup();
  }
});

test('loads the exact package regex from governance/packages.yaml', () => {
  const setup = temporaryRoot();
  try {
    write(join(setup.path, 'package.json'), JSON.stringify({
      name: '@autorepo/g1-tooling',
      workspaces: ['packages/*'],
    }));
    write(join(setup.path, 'governance/packages.yaml'), readFileSync(join(root, 'governance/packages.yaml')));
    write(join(setup.path, 'packages/valid/package.json'), JSON.stringify({ name: '@autorepo/valid-package' }));
    let errors = [];
    validateWorkspaceNamespace(setup.path, { package_policy: 'governance/packages.yaml' }, errors);
    assert.deepEqual(errors, []);
    write(join(setup.path, 'packages/invalid/package.json'), JSON.stringify({ name: '@autorepo/Invalid_Name' }));
    errors = [];
    validateWorkspaceNamespace(setup.path, { package_policy: 'governance/packages.yaml' }, errors);
    assert.match(errors.join('\n'), /package name must match governance\/packages.yaml/);
  } finally {
    setup.cleanup();
  }
});

test('normalizes workflow trigger forms, safely accepts compact SHA-pinned uses, and scopes secrets to PRs', () => {
  const pin = 'a'.repeat(40);
  const compact = `on: [pull_request]\npermissions: { contents: read }\njobs:\n  test:\n    steps:\n      - uses: actions/checkout@${pin} # v4\n`;
  assert.deepEqual(validateWorkflowDocument(compact, 'compact'), []);
  const target = `on: { pull_request_target: {} }\npermissions: read-all\njobs: {}\n`;
  assert.match(validateWorkflowDocument(target, 'target').join('\n'), /pull_request_target is forbidden/);
  const secretPr = `on: pull_request\npermissions: { contents: read }\njobs:\n  test:\n    steps:\n      - run: echo \${{ secrets.TOKEN }}\n`;
  assert.match(validateWorkflowDocument(secretPr, 'secret-pr').join('\n'), /must not access secrets/);
  const secretPush = `on: push\npermissions: { contents: read }\njobs:\n  test:\n    steps:\n      - run: echo \${{ secrets.TOKEN }}\n`;
  assert.deepEqual(validateWorkflowDocument(secretPush, 'secret-push'), []);
});

test('accepts current trusted security-event write jobs while keeping PR jobs read-only', () => {
  const errors = [];
  validateWorkflows(root, policy, errors);
  assert.deepEqual(errors, []);
});

test('requires per-setting matched or deferred evidence instead of a fabricated global match', () => {
  const setup = temporaryRoot();
  try {
    write(join(setup.path, 'evidence.json'), JSON.stringify({
      schema_version: 1,
      observed_at: '2026-08-08T00:00:00Z',
      desired: { issues: true, discussions: false },
      live: { settings: { issues: true } },
      comparison: {
        settings: {
          issues: { status: 'matched' },
          discussions: { status: 'deferred', reason: 'provider readback pending' },
        },
      },
    }));
    const errors = [];
    validateSettingsEvidence(setup.path, { settings_evidence: 'evidence.json' }, contracts, errors);
    assert.deepEqual(errors, []);
    write(join(setup.path, 'evidence.json'), JSON.stringify({
      schema_version: 1, observed_at: '2026-08-08T00:00:00Z', desired: { issues: true },
      live: { settings: { issues: false } }, comparison: { settings: { issues: { status: 'matched' } } },
    }));
    const failing = [];
    validateSettingsEvidence(setup.path, { settings_evidence: 'evidence.json' }, contracts, failing);
    assert.match(failing.join('\n'), /differs from desired/);
  } finally {
    setup.cleanup();
  }
});

test('accepts authorized per-setting deferrals backed by a desired contract', () => {
  const errors = [];
  validateSettingsEvidence(root, policy, contracts, errors);
  assert.deepEqual(errors, []);
});

test('requires structured clean-room policy, inventory, tool, and hash-only report metadata', () => {
  const setup = temporaryRoot();
  try {
    write(join(setup.path, 'governance/source-inventory.attestation.schema.json'), readFileSync(join(root, 'governance/source-inventory.attestation.schema.json')));
    write(join(setup.path, 'attestation.yaml'), `schema_version: 1
schema: "governance/source-inventory.attestation.schema.json"
policy_version: "autorepo-clean-room-v1"
attestation:
  id: "autorepo-clean-room-attestation-v1"
  status: "scan_attested"
  result: "restricted inventory and public-output scan passed at baseline"
  recorded_at: "2026-08-08T00:00:00Z"
restricted_inventory:
  digest_algorithm: "sha256"
  digest: "c5fe7b1bb77b54cdfdde3bfee3d2b90cada3a6ee57cc5e67669ed0710602b39c"
  entry_count: 4
immutable_external_evidence:
  status: "references_recorded"
  restricted_scan_report_sha256: "${'b'.repeat(64)}"
  restricted_tool_manifest_sha256: "${'c'.repeat(64)}"
  public_boundary: "opaque references only"
public_disclosure: "no restricted content"
author_review_requirement: "independent review required"
`);
    const errors = [];
    validateCleanRoom(setup.path, {
      clean_room_attestation: 'attestation.yaml', clean_room_schema: 'governance/source-inventory.attestation.schema.json',
    }, contracts, errors);
    assert.deepEqual(errors, []);
  } finally {
    setup.cleanup();
  }
});

test('clean-room scanner fails closed, detects injected corpus identifiers and hashes, and emits hash-only reports', () => {
  const setup = temporaryRoot();
  try {
    const injectedIdentifier = 'restricted-corpus-identifier';
    const hashMatched = 'restricted-file-bytes\n';
    const manifest = {
      schema_version: 1,
      restricted_inventory_digest: 'c'.repeat(64),
      entry_count: 2,
      prohibited_identifiers: [injectedIdentifier],
      prohibited_file_hashes: [createHash('sha256').update(hashMatched).digest('hex')],
    };
    write(join(setup.path, 'corpus.json'), JSON.stringify(manifest));
    write(join(setup.path, 'public/a.md'), injectedIdentifier);
    write(join(setup.path, 'public/b.txt'), hashMatched);
    const reportPath = join(setup.path, 'report.json');
    const { findings, report } = scanCleanRoom({
      publicRoot: join(setup.path, 'public'), confidentialCorpusManifest: join(setup.path, 'corpus.json'), reportPath,
    });
    assert.equal(findings.length, 2);
    assert.equal(report.finding_count, 2);
    const reportText = readFileSync(reportPath, 'utf8');
    assert.doesNotMatch(reportText, new RegExp(injectedIdentifier));
    assert.doesNotMatch(reportText, new RegExp(hashMatched.trim()));
    assert.throws(() => scanCleanRoom({ publicRoot: join(setup.path, 'public'), reportPath }), /corpus manifest is required/);
  } finally {
    setup.cleanup();
  }
});

test('clean-room scanner rejects large, binary, and archive public files without disclosing their contents', () => {
  const setup = temporaryRoot();
  try {
    write(join(setup.path, 'corpus.json'), JSON.stringify({
      schema_version: 1, restricted_inventory_digest: 'd'.repeat(64), entry_count: 1,
      prohibited_identifiers: ['opaque'], prohibited_file_hashes: [],
    }));
    write(join(setup.path, 'public/archive.zip'), 'not an archive payload');
    write(join(setup.path, 'public/binary.bin'), Buffer.from([0, 1, 2]));
    write(join(setup.path, 'public/large.md'), 'x'.repeat(10));
    const { findings } = scanCleanRoom({
      publicRoot: join(setup.path, 'public'), confidentialCorpusManifest: join(setup.path, 'corpus.json'),
      reportPath: join(setup.path, 'report.json'), maxFileBytes: 5,
    });
    assert.equal(findings.length, 3);
    assert.deepEqual(new Set(findings.map((entry) => entry.code)), new Set([
      'archive-file', 'unrecognized-or-binary-file', 'oversized-file',
    ]));
  } finally {
    setup.cleanup();
  }
});
