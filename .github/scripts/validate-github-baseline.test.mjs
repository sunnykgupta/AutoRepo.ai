import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { findPullRequestSafetyViolations, findUnpinnedActionLines, parseWorkflowYaml, validateBaseline } from './validate-github-baseline.mjs';

const repoRoot = process.cwd();

test('accepts full-SHA action references with version comments', () => {
  const workflow = 'uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4\n';
  assert.deepEqual(findUnpinnedActionLines(workflow), []);
});

test('parses compact pull request triggers and compact action steps', () => {
  const workflow = [
    'on: { pull_request: { branches: [main] } }',
    'permissions: { contents: read }',
    'jobs:',
    '  check:',
    '    steps:',
    '      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4'
  ].join('\n');
  assert.deepEqual(findUnpinnedActionLines(workflow), []);
  assert.deepEqual(findPullRequestSafetyViolations(workflow), []);
});

test('rejects pull_request_target in scalar, list, and map trigger forms', () => {
  for (const trigger of ['on: pull_request_target', 'on: [pull_request_target]', 'on: { pull_request_target: {} }']) {
    assert.deepEqual(findPullRequestSafetyViolations(`${trigger}\npermissions: { contents: read }\n`), ['must not use pull_request_target']);
  }
});

test('allows write permissions only in a job gated away from pull requests', () => {
  const workflow = [
    'on: [pull_request, push]',
    'permissions: { contents: read }',
    'jobs:',
    '  pull-request-check:',
    '    steps:',
    '      - uses: github/codeql-action/init@24c7eb380a2dc368f2d129e4c65e51d172983a1e # v4',
    '  trusted-upload:',
    "    if: github.event_name != 'pull_request'",
    '    permissions: { contents: read, security-events: write }',
    '    steps:',
    '      - uses: github/codeql-action/analyze@24c7eb380a2dc368f2d129e4c65e51d172983a1e # v4'
  ].join('\n');
  assert.deepEqual(findUnpinnedActionLines(workflow), []);
  assert.deepEqual(findPullRequestSafetyViolations(workflow), []);
});

test('keeps trusted Scorecard upload permissions at job scope', () => {
  const workflow = readFileSync(resolve(repoRoot, '.github/workflows/scorecard.yml'), 'utf8');
  const document = parseWorkflowYaml(workflow);
  assert.deepEqual(document.permissions, { contents: 'read' });
  assert.deepEqual(document.jobs.analysis.permissions, {
    contents: 'read',
    'id-token': 'write',
    'security-events': 'write',
  });
});

test('rejects mutable action references and unsafe pull request capabilities', () => {
  const workflow = [
    'on:\n  pull_request:',
    'permissions:\n  contents: write',
    'steps:\n  - uses: actions/checkout@v4',
    '  - run: echo ${{ secrets.DEPLOY_TOKEN }}'
  ].join('\n');
  assert.equal(findUnpinnedActionLines(workflow).length, 1);
  assert.deepEqual(findPullRequestSafetyViolations(workflow), [
    'must set top-level contents: read permissions',
    'must not request write permissions',
    'must not reference secrets'
  ]);
});

test('validates the checked-in GitHub baseline', async () => {
  assert.deepEqual(await validateBaseline(), []);
});
