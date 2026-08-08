import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import YAML from 'yaml';
import {
  EVENT_TYPES,
  LEGAL_TRANSITIONS,
  STATES,
  loadLedger,
  metadataSha256,
  parseWorkItemMarkdown,
  pathsOverlap,
  replayEvidence,
  validScopePath,
} from '../scripts/governance/ledger.mjs';
import {
  authenticatedEventActorErrors,
  verifyResumeWorktree,
  worktreeBinding,
} from '../scripts/governance/git-context.mjs';
import {
  runRuntimeTransportDenialHarness,
  runtimeBoundaryDescription,
  validateIntegrationBoundary,
} from '../scripts/integration-boundary.mjs';
import {
  ConfluenceRenderFake,
  JiraProjectionFake,
} from '../integrations/fakes/atlassian-fakes.mjs';

const root = process.cwd();
const knownBase = '11129c8de6829327075b829c971bd62a8dbc9d80';
const sha = 'a'.repeat(40);
const owner = actor('principal:owner-agent', 'owner-agent', 'agent');
const ownerTwo = actor('principal:owner-two', 'owner-two', 'agent');
const reviewer = actor('principal:review-agent', 'review-agent', 'agent');
const reviewerTwo = actor('principal:review-two', 'review-two', 'agent');
const humanReviewer = actor('principal:human-reviewer', 'human-reviewer', 'human');
const maintainer = actor('principal:sunny-r-gupta', 'sunnykgupta', 'maintainer');
const governanceHumanReviewer = actor('principal:sunny-r-gupta', 'sunnykgupta', 'human');
const operationAgent = actor('principal:operation-agent', 'operation-agent', 'agent');
const baseScope = Object.freeze({ packages: [], paths: ['tests/**'], exclusive_resources: [] });

function actor(principal, github_actor, kind) {
  return { principal, github_actor, kind };
}

function time(sequence) {
  return new Date(Date.UTC(2026, 7, 8, 0, 0, sequence)).toISOString().replace('.000Z', 'Z');
}

function event(sequence, type, fields = {}, eventActor = owner, itemId = 'TEST-1') {
  return {
    schema_version: 1,
    event_id: `event-${String(sequence).padStart(3, '0')}`,
    work_item_id: itemId,
    sequence,
    occurred_at: time(sequence),
    type,
    actor: eventActor,
    ...fields,
  };
}

function item(state = 'PROPOSED', options = {}) {
  return {
    schema_version: 1,
    id: options.id ?? 'TEST-1',
    title: options.title ?? 'Synthetic test item',
    state,
    dependencies: options.dependencies ?? [],
    scope: options.scope ?? structuredClone(baseScope),
    acceptance: { required_checks: options.requiredChecks ?? ['governance', 'tests'] },
    clean_room: {
      author_attestation_required: options.clean ?? false,
      provenance: options.clean ? 'independent-review-required' : 'independently-authored',
    },
  };
}

function request(options = {}) {
  return {
    claim_id: options.claimId ?? 'claim-test-001',
    principal: options.owner?.principal ?? owner.principal,
    github_actor: options.owner?.github_actor ?? owner.github_actor,
    base_sha: options.baseSha ?? sha,
    expires_at: options.expiresAt ?? '2030-01-01T00:00:00Z',
    branch: options.branch ?? 'synthetic',
    worktree: options.worktree ?? `sha256:${'c'.repeat(64)}`,
    ...(options.scope ?? structuredClone(baseScope)),
  };
}

function activationPrefix(options = {}) {
  const wanted = request(options);
  return [
    event(1, 'STATE_TRANSITION', { from_state: 'PROPOSED', to_state: 'READY' }),
    event(2, 'CLAIM_REQUEST', { request: wanted }, options.owner ?? owner),
    event(3, 'CLAIM', { claim: { ...wanted, request_sha: options.requestSha ?? sha } }, options.owner ?? owner),
  ];
}

function requestedOperation(
  sequence,
  operationType,
  proposal,
  operationActor = owner,
  options = {},
) {
  return event(
    sequence,
    'OPERATION_REQUEST',
    {
      operation_id: options.operationId ?? `operation-${String(sequence).padStart(3, '0')}`,
      operation_type: operationType,
      operation_actor: operationActor,
      proposal,
      reason: options.reason ?? 'Synthetic reviewed operation',
    },
    operationActor,
    options.itemId ?? 'TEST-1',
  );
}

function reviewedOperation(sequence, type, fields, requestEvent, reviewActor = reviewer, options = {}) {
  return event(
    sequence,
    type,
    {
      ...fields,
      operation_id: requestEvent.operation_id,
      operation_actor: requestEvent.operation_actor,
      operation_request_event_id: requestEvent.event_id,
      operation_request_sha: options.requestSha ?? sha,
      review: reviewActor,
      reason: requestEvent.reason,
    },
    reviewActor,
    options.itemId ?? 'TEST-1',
  );
}

function principals() {
  const values = new Map([
    [humanReviewer.principal, { active: true, type: 'human', github: humanReviewer.github_actor }],
    [maintainer.principal, { active: true, type: 'human', github: maintainer.github_actor }],
  ]);
  values.activeMaintainers = new Set([maintainer.principal]);
  return values;
}

function evidenceVariants() {
  const wanted = request();
  const active = { ...wanted, request_sha: sha };
  const renewal = {
    claim_id: active.claim_id,
    principal: active.principal,
    github_actor: active.github_actor,
    expires_at: '2031-01-01T00:00:00Z',
    packages: active.packages,
    paths: active.paths,
    exclusive_resources: active.exclusive_resources,
  };
  const operation = requestedOperation(
    1,
    'RENEW',
    { target_claim_id: active.claim_id, renewal },
  );
  const reviewed = {
    operation_id: operation.operation_id,
    operation_actor: owner,
    operation_request_event_id: operation.event_id,
    operation_request_sha: sha,
    review: reviewer,
    reason: operation.reason,
  };
  return [
    event(1, 'STATE_TRANSITION', { from_state: 'PROPOSED', to_state: 'READY' }),
    event(1, 'CLAIM_REQUEST', { request: wanted }),
    event(1, 'CLAIM', { claim: active }),
    operation,
    event(1, 'RENEW', { renewal, ...reviewed }, reviewer),
    event(1, 'RELEASE', { from_state: 'CLAIMED', target_claim_id: active.claim_id, ...reviewed }, reviewer),
    event(1, 'HANDOFF', { from_state: 'IN_REVIEW', target_claim_id: active.claim_id, ...reviewed }, reviewer),
    event(1, 'PAUSE', { from_state: 'CLAIMED', target_claim_id: active.claim_id, ...reviewed }, reviewer),
    event(1, 'CANCEL_CLAIM', { from_state: 'IN_REVIEW', target_claim_id: active.claim_id, ...reviewed }, reviewer),
    event(
      1,
      'RECLAIM',
      {
        claim: active,
        operation_id: operation.operation_id,
        operation_actor: maintainer,
        operation_request_event_id: operation.event_id,
        operation_request_sha: sha,
        review: reviewer,
        reason: 'Synthetic reclaim',
      },
      reviewer,
    ),
    event(1, 'REVIEW', { review: reviewer, reviewed_sha: sha }, reviewer),
    event(1, 'PROVENANCE_ATTESTATION', {
      provenance: { attestation: 'independently-authored', redacted: true },
    }),
    event(
      1,
      'PROVENANCE_REVIEW',
      { review: humanReviewer, reviewed_sha: sha, provenance: { redacted: true } },
      humanReviewer,
    ),
    event(1, 'ACCEPTANCE', {
      acceptance: {
        tested_sha: sha,
        merged_sha: sha,
        checks: [
          { name: 'governance', status: 'passed' },
          { name: 'tests', status: 'passed' },
        ],
      },
    }),
    event(
      1,
      'WORK_ITEM_AMENDMENT',
      {
        before_metadata_sha256: 'a'.repeat(64),
        after_metadata_sha256: 'b'.repeat(64),
        operation_id: operation.operation_id,
        operation_actor: operationAgent,
        operation_request_event_id: operation.event_id,
        operation_request_sha: sha,
        review: reviewer,
        reason: operation.reason,
      },
      reviewer,
    ),
  ];
}

function writeCanonical(path, value) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeItem(path, metadata, body = '\n# Synthetic item\n') {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `---\n${YAML.stringify(metadata).trimEnd()}\n---\n${body}`);
}

function ledgerFixture() {
  const path = mkdtempSync('/var/tmp/autorepo-ledger-test-');
  for (const directory of ['work/items', 'work/evidence', 'work/schema', 'governance']) {
    mkdirSync(join(path, directory), { recursive: true });
  }
  cpSync(join(root, 'work/schema/work-item.schema.json'), join(path, 'work/schema/work-item.schema.json'));
  cpSync(join(root, 'work/schema/work-evidence.schema.json'), join(path, 'work/schema/work-evidence.schema.json'));
  cpSync(join(root, 'governance/owners.yaml'), join(path, 'governance/owners.yaml'));
  return { path, done: () => rmSync(path, { recursive: true, force: true }) };
}

function command(cwd, executable, args, environment = {}) {
  return spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
    maxBuffer: 16 * 1024 * 1024,
  });
}

function git(cwd, args) {
  const result = command(cwd, 'git', args);
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function overlayWorkingTree(destination) {
  for (const name of readdirTop(root)) {
    if (name === '.git' || name === 'node_modules') continue;
    cpSync(join(root, name), join(destination, name), { recursive: true, force: true });
  }
  if (!existsSync(join(destination, 'node_modules'))) {
    cpSync(join(root, 'node_modules'), join(destination, 'node_modules'), { recursive: true });
  }
}

function readdirTop(path) {
  return readdirSync(path);
}

function syntheticBootstrap(options = {}) {
  const parent = mkdtempSync('/var/tmp/autorepo-git-test-');
  const path = join(parent, 'repository');
  git(parent, ['clone', '--shared', '--no-checkout', root, path]);
  git(path, ['checkout', '-B', 'synthetic', knownBase]);
  git(path, ['config', 'user.name', 'Synthetic Test']);
  git(path, ['config', 'user.email', 'synthetic@example.invalid']);
  overlayWorkingTree(path);
  if (options.clean === true) {
    updateItem(path, (metadata) => {
      metadata.clean_room.author_attestation_required = true;
      metadata.clean_room.provenance = 'independent-review-required';
    });
  }
  git(path, ['add', '-A']);
  git(path, ['commit', '-m', 'synthetic G2a bootstrap']);
  const bootstrap = git(path, ['rev-parse', 'HEAD']);
  return {
    parent,
    path,
    bootstrap,
    done: () => rmSync(parent, { recursive: true, force: true }),
  };
}

function commitAll(path, message) {
  git(path, ['add', '-A']);
  git(path, ['commit', '-m', message]);
  return git(path, ['rev-parse', 'HEAD']);
}

function runValidator(path, base, environment = {}) {
  return command(
    path,
    process.execPath,
    ['scripts/governance/validate.mjs', '--now', '2026-08-08T00:10:00Z'],
    {
      GITHUB_EVENT_NAME: 'pull_request',
      GOVERNANCE_BASE_SHA: base,
      ...environment,
    },
  );
}

function assertPassed(result, label) {
  assert.equal(result.status, 0, `${label}\n${result.stdout}\n${result.stderr}`);
}

function assertRejected(result, pattern, label) {
  assert.notEqual(result.status, 0, `${label}: validator unexpectedly passed`);
  assert.match(`${result.stdout}\n${result.stderr}`, pattern, label);
}

function updateItem(path, mutate, bodyMutate) {
  const file = join(path, 'work/items/G2A.md');
  const parsed = parseWorkItemMarkdown(readFileSync(file, 'utf8'));
  const metadata = structuredClone(parsed.metadata);
  mutate?.(metadata);
  const body = bodyMutate ? bodyMutate(parsed.body) : parsed.body;
  writeItem(file, metadata, body);
  return { before: parsed.metadata, after: metadata };
}

function addG2aEvent(path, value) {
  const file = join(
    path,
    'work/evidence/G2A',
    `${String(value.sequence).padStart(4, '0')}-${value.event_id}.json`,
  );
  writeCanonical(file, value);
  return file;
}

function g2aEvent(sequence, type, fields = {}, eventActor = owner) {
  return event(sequence, type, fields, eventActor, 'G2A');
}

function regenerate(path) {
  const result = command(path, process.execPath, ['scripts/governance/generate-views.mjs']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function buildClaimedHistory(setup) {
  const { path, bootstrap } = setup;
  const readyChange = updateItem(path, (metadata) => {
    metadata.state = 'READY';
  });
  addG2aEvent(path, g2aEvent(1, 'STATE_TRANSITION', { from_state: 'PROPOSED', to_state: 'READY' }));
  regenerate(path);
  const ready = commitAll(path, 'synthetic ready operation');
  assertPassed(
    runValidator(path, bootstrap, { GITHUB_ACTOR: owner.github_actor }),
    'READY operation',
  );

  const wanted = request({
    claimId: 'claim-g2a-synthetic',
    baseSha: ready,
    worktree: worktreeBinding(path),
    scope: structuredClone(readyChange.after.scope),
  });
  addG2aEvent(path, g2aEvent(2, 'CLAIM_REQUEST', { request: wanted }, owner));
  const requestCommit = commitAll(path, 'synthetic claim request');
  assertPassed(
    runValidator(path, ready, { GITHUB_ACTOR: owner.github_actor, GITHUB_HEAD_REF: wanted.branch }),
    'claim-only request',
  );

  const claimedChange = updateItem(path, (metadata) => {
    metadata.state = 'CLAIMED';
  });
  addG2aEvent(
    path,
    g2aEvent(3, 'CLAIM', { claim: { ...wanted, request_sha: requestCommit } }, owner),
  );
  regenerate(path);
  const activation = commitAll(path, 'synthetic claim activation');
  assertPassed(
    runValidator(path, requestCommit, {
      GITHUB_ACTOR: owner.github_actor,
      GITHUB_HEAD_REF: wanted.branch,
    }),
    'later activation',
  );
  return { ready, wanted, requestCommit, activation };
}

function buildReclaimedHistory(setup, history) {
  const releaseRequest = requestedOperation(
    4,
    'RELEASE',
    { target_claim_id: history.wanted.claim_id, from_state: 'CLAIMED' },
    owner,
    { itemId: 'G2A', reason: 'Release old owner' },
  );
  addG2aEvent(setup.path, releaseRequest);
  const releaseRequestCommit = commitAll(setup.path, 'synthetic release request');
  assertPassed(
    runValidator(setup.path, history.activation, {
      GITHUB_ACTOR: owner.github_actor,
      GITHUB_HEAD_REF: history.wanted.branch,
    }),
    'owner-authenticated release request',
  );

  const releasedChange = updateItem(setup.path, (metadata) => {
    metadata.state = 'READY';
  });
  addG2aEvent(
    setup.path,
    reviewedOperation(
      5,
      'RELEASE',
      { from_state: 'CLAIMED', target_claim_id: history.wanted.claim_id },
      releaseRequest,
      reviewer,
      { itemId: 'G2A', requestSha: releaseRequestCommit },
    ),
  );
  regenerate(setup.path);
  const closure = commitAll(setup.path, 'synthetic typed release');
  assertPassed(
    runValidator(setup.path, releaseRequestCommit, {
      GITHUB_ACTOR: reviewer.github_actor,
      GITHUB_HEAD_REF: history.wanted.branch,
    }),
    'typed release',
  );

  const next = request({
    claimId: 'claim-g2a-next',
    owner: ownerTwo,
    baseSha: closure,
    worktree: worktreeBinding(setup.path),
    scope: structuredClone(releasedChange.after.scope),
  });
  addG2aEvent(setup.path, g2aEvent(6, 'CLAIM_REQUEST', { request: next }, ownerTwo));
  const requestCommit = commitAll(setup.path, 'synthetic second claim request');
  assertPassed(
    runValidator(setup.path, closure, {
      GITHUB_ACTOR: ownerTwo.github_actor,
      GITHUB_HEAD_REF: next.branch,
    }),
    'second claim-only request',
  );

  const reclaimClaim = { ...next, request_sha: requestCommit };
  const reclaimRequest = requestedOperation(
    7,
    'RECLAIM',
    { target_request_id: next.claim_id, claim: reclaimClaim },
    maintainer,
    { itemId: 'G2A', reason: 'Activate next owner after closure' },
  );
  addG2aEvent(setup.path, reclaimRequest);
  const reclaimRequestCommit = commitAll(setup.path, 'synthetic O1 reclaim request');
  assertPassed(
    runValidator(setup.path, requestCommit, {
      GITHUB_ACTOR: maintainer.github_actor,
      GITHUB_HEAD_REF: next.branch,
    }),
    'O1-authenticated reclaim request',
  );

  updateItem(setup.path, (metadata) => {
    metadata.state = 'CLAIMED';
  });
  addG2aEvent(
    setup.path,
    reviewedOperation(
      8,
      'RECLAIM',
      { claim: reclaimClaim },
      reclaimRequest,
      reviewerTwo,
      { itemId: 'G2A', requestSha: reclaimRequestCommit },
    ),
  );
  regenerate(setup.path);
  const reclaim = commitAll(setup.path, 'synthetic governed reclaim');
  assertPassed(
    runValidator(setup.path, reclaimRequestCommit, {
      GITHUB_ACTOR: reviewerTwo.github_actor,
      GITHUB_HEAD_REF: next.branch,
    }),
    'governed reclaim',
  );
  return {
    closure,
    releaseRequestCommit,
    next,
    requestCommit,
    reclaimRequestCommit,
    reclaim,
  };
}

function buildReviewedHistory(setup) {
  const history = buildClaimedHistory(setup);
  writeFileSync(join(setup.path, 'governance/reviewed-implementation.mjs'), 'export const reviewed = true;\n');
  const implementation = commitAll(setup.path, 'synthetic reviewed implementation');
  assertPassed(
    runValidator(setup.path, history.activation, {
      GITHUB_ACTOR: owner.github_actor,
      GITHUB_HEAD_REF: history.wanted.branch,
    }),
    'reviewed implementation PR',
  );
  updateItem(setup.path, (metadata) => {
    metadata.state = 'IN_REVIEW';
  });
  addG2aEvent(
    setup.path,
    g2aEvent(4, 'STATE_TRANSITION', { from_state: 'CLAIMED', to_state: 'IN_REVIEW' }),
  );
  regenerate(setup.path);
  const reviewTransition = commitAll(setup.path, 'synthetic reviewed transition');
  assertPassed(
    runValidator(setup.path, implementation, {
      GITHUB_ACTOR: owner.github_actor,
      GITHUB_HEAD_REF: history.wanted.branch,
    }),
    'reviewed transition PR',
  );
  addG2aEvent(
    setup.path,
    g2aEvent(5, 'REVIEW', { review: reviewer, reviewed_sha: implementation }, reviewer),
  );
  const reviewCommit = commitAll(setup.path, 'synthetic reviewed independent review');
  assertPassed(
    runValidator(setup.path, reviewTransition, {
      GITHUB_ACTOR: reviewer.github_actor,
      GITHUB_HEAD_REF: history.wanted.branch,
    }),
    'reviewed independent review PR',
  );
  return { ...history, implementation, reviewTransition, reviewCommit };
}

test('Draft 2020-12 schema accepts all exact event variants and rejects unknown and irrelevant fields', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat('date-time', true);
  const validate = ajv.compile(
    JSON.parse(readFileSync(join(root, 'work/schema/work-evidence.schema.json'), 'utf8')),
  );
  const variants = evidenceVariants();
  assert.deepEqual(variants.map((value) => value.type), EVENT_TYPES);
  for (const value of variants) {
    assert.equal(validate(value), true, `${value.type}: ${JSON.stringify(validate.errors)}`);
    assert.equal(validate({ ...value, unexpected: true }), false, `${value.type} accepted unknown field`);
    assert.equal(
      validate({ ...value, irrelevant_request: request() }),
      false,
      `${value.type} accepted irrelevant field`,
    );
  }
  assert.equal(validate({ ...variants[10], type: 'UNKNOWN' }), false);
  assert.equal(validate({ ...variants[1], request: { ...request(), request_sha: sha } }), false);
  assert.equal(validate({ ...variants[4], renewal: { ...variants[4].renewal, branch: 'extra' } }), false);
});

test('all newly added event types bind to the authenticated PR actor while merge-group replay does not bind queue actor', () => {
  for (const value of evidenceVariants()) {
    assert.deepEqual(
      authenticatedEventActorErrors(value, {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_ACTOR: value.actor.github_actor,
      }),
      [],
      value.type,
    );
    assert.match(
      authenticatedEventActorErrors(value, {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_ACTOR: 'different-authenticated-actor',
      }).join('\n'),
      /does not match authenticated PR actor/,
      value.type,
    );
    assert.deepEqual(
      authenticatedEventActorErrors(value, {
        GITHUB_EVENT_NAME: 'merge_group',
        GITHUB_ACTOR: 'github-merge-queue',
      }),
      [],
      value.type,
    );
  }
});

test('reviewers cannot authenticate forged owner or O1 operation requests', () => {
  const ownerRequest = requestedOperation(
    1,
    'RELEASE',
    { target_claim_id: 'claim-test-001', from_state: 'CLAIMED' },
    owner,
  );
  const o1Request = requestedOperation(
    1,
    'RECLAIM',
    { target_request_id: 'claim-test-002', claim: { ...request(), request_sha: sha } },
    maintainer,
  );
  for (const requestEvent of [ownerRequest, o1Request]) {
    assert.match(
      authenticatedEventActorErrors(requestEvent, {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_ACTOR: reviewer.github_actor,
      }).join('\n'),
      /does not match authenticated PR actor/,
    );
  }
});

test('all 49 state pairs agree with replay legality and ownership entry/exit remains typed', () => {
  assert.equal(STATES.length, 7);
  function prefix(state) {
    if (state === 'PROPOSED') return [];
    if (state === 'BLOCKED') {
      return [event(1, 'STATE_TRANSITION', { from_state: 'PROPOSED', to_state: 'BLOCKED' })];
    }
    if (state === 'READY') {
      return [event(1, 'STATE_TRANSITION', { from_state: 'PROPOSED', to_state: 'READY' })];
    }
    if (state === 'CLAIMED') return activationPrefix();
    if (state === 'IN_REVIEW') {
      return [
        ...activationPrefix(),
        event(4, 'STATE_TRANSITION', { from_state: 'CLAIMED', to_state: 'IN_REVIEW' }),
      ];
    }
    if (state === 'DONE') {
      return [
        ...prefix('IN_REVIEW'),
        event(5, 'REVIEW', { review: reviewer, reviewed_sha: sha }, reviewer),
        event(6, 'ACCEPTANCE', {
          acceptance: {
            tested_sha: sha,
            merged_sha: sha,
            checks: [
              { name: 'governance', status: 'passed' },
              { name: 'tests', status: 'passed' },
            ],
          },
        }),
        event(7, 'STATE_TRANSITION', { from_state: 'IN_REVIEW', to_state: 'DONE' }),
      ];
    }
    return [event(1, 'STATE_TRANSITION', { from_state: 'PROPOSED', to_state: 'CANCELLED' })];
  }
  for (const from of STATES) {
    for (const to of STATES) {
      const expected = LEGAL_TRANSITIONS[from].has(to);
      const events = prefix(from);
      if (from === 'IN_REVIEW' && to === 'DONE') {
        events.push(
          event(events.length + 1, 'REVIEW', { review: reviewer, reviewed_sha: sha }, reviewer),
          event(events.length + 2, 'ACCEPTANCE', {
            acceptance: {
              tested_sha: sha,
              merged_sha: sha,
              checks: [
                { name: 'governance', status: 'passed' },
                { name: 'tests', status: 'passed' },
              ],
            },
          }),
        );
      }
      events.push(
        event(events.length + 1, 'STATE_TRANSITION', { from_state: from, to_state: to }),
      );
      const probe = replayEvidence(item(to), events, new Date('2026-08-08T00:01:00Z'), principals());
      if (expected) {
        assert.deepEqual(probe.errors, [], `${from} -> ${to}: ${probe.errors.join('; ')}`);
      } else {
        assert.match(probe.errors.join('\n'), /generic transition is illegal/, `${from} -> ${to}`);
      }
    }
  }
  for (const pair of [
    ['READY', 'CLAIMED'],
    ['CLAIMED', 'READY'],
    ['CLAIMED', 'BLOCKED'],
    ['CLAIMED', 'CANCELLED'],
    ['IN_REVIEW', 'READY'],
  ]) {
    assert.equal(LEGAL_TRANSITIONS[pair[0]].has(pair[1]), false);
  }
});

test('replay rejects timestamp, expiry, activation actor, payload, and request-consumption bypasses', () => {
  const active = activationPrefix();
  assert.deepEqual(
    replayEvidence(item('CLAIMED'), active, new Date('2026-08-08T00:00:10Z'), principals()).errors,
    [],
  );

  const reordered = structuredClone(active);
  reordered[2].occurred_at = time(1);
  assert.match(replayEvidence(item('CLAIMED'), reordered).errors.join('\n'), /monotonic/);

  const mismatch = structuredClone(active);
  mismatch[2].claim.paths = ['other/**'];
  assert.match(replayEvidence(item('CLAIMED'), mismatch).errors.join('\n'), /exactly match/);

  const wrongActor = structuredClone(active);
  wrongActor[2].actor = ownerTwo;
  assert.match(replayEvidence(item('CLAIMED'), wrongActor).errors.join('\n'), /owner actor/);

  const expiringRequest = request({ expiresAt: time(3) });
  const expired = [
    event(1, 'STATE_TRANSITION', { from_state: 'PROPOSED', to_state: 'READY' }),
    event(2, 'CLAIM_REQUEST', { request: expiringRequest }),
    event(3, 'CLAIM', { claim: { ...expiringRequest, request_sha: sha } }),
  ];
  assert.match(replayEvidence(item('CLAIMED'), expired).errors.join('\n'), /future-dated|activation/);

  const expiresBeforeNext = request({ expiresAt: time(4) });
  const stopped = [
    event(1, 'STATE_TRANSITION', { from_state: 'PROPOSED', to_state: 'READY' }),
    event(2, 'CLAIM_REQUEST', { request: expiresBeforeNext }),
    event(3, 'CLAIM', { claim: { ...expiresBeforeNext, request_sha: sha } }),
    event(4, 'STATE_TRANSITION', { from_state: 'CLAIMED', to_state: 'IN_REVIEW' }),
  ];
  assert.match(replayEvidence(item('READY'), stopped).errors.join('\n'), /expiry stops work/);

  const reused = [
    ...active,
    event(
      4,
      'RELEASE',
      { from_state: 'CLAIMED', operation_actor: owner, review: reviewer, reason: 'Close' },
      reviewer,
    ),
    event(
      5,
      'RECLAIM',
      {
        claim: active[2].claim,
        operation_actor: maintainer,
        review: reviewerTwo,
        reason: 'Illegal reuse',
      },
      reviewerTwo,
    ),
  ];
  assert.match(replayEvidence(item('CLAIMED'), reused, new Date(), principals()).errors.join('\n'), /new later request/);
});

test('renewal, closure, reclaim, reviewer binding, and maintainer rules are exact', () => {
  const renewal = {
    claim_id: 'claim-test-001',
    principal: owner.principal,
    github_actor: owner.github_actor,
    expires_at: '2031-01-01T00:00:00Z',
    ...structuredClone(baseScope),
  };
  const renewRequest = requestedOperation(
    4,
    'RENEW',
    { target_claim_id: renewal.claim_id, renewal },
    owner,
    { reason: 'Extend lease' },
  );
  const renewed = [
    ...activationPrefix(),
    renewRequest,
    reviewedOperation(5, 'RENEW', { renewal }, renewRequest),
  ];
  assert.deepEqual(replayEvidence(item('CLAIMED'), renewed, new Date(), principals()).errors, []);
  const shortened = structuredClone(renewed);
  shortened[4].renewal.expires_at = '2029-01-01T00:00:00Z';
  assert.match(replayEvidence(item('CLAIMED'), shortened, new Date(), principals()).errors.join('\n'), /exactly extend/);

  for (const [type, target] of [
    ['RELEASE', 'READY'],
    ['HANDOFF', 'READY'],
    ['PAUSE', 'BLOCKED'],
    ['CANCEL_CLAIM', 'CANCELLED'],
  ]) {
    const closureRequest = requestedOperation(
      4,
      type,
      { target_claim_id: 'claim-test-001', from_state: 'CLAIMED' },
      owner,
      { reason: 'Close' },
    );
    const flow = [
      ...activationPrefix(),
      closureRequest,
      reviewedOperation(
        5,
        type,
        { from_state: 'CLAIMED', target_claim_id: 'claim-test-001' },
        closureRequest,
      ),
    ];
    assert.deepEqual(replayEvidence(item(target), flow, new Date(), principals()).errors, [], type);
  }

  const first = activationPrefix();
  const next = request({ claimId: 'claim-test-002', owner: ownerTwo });
  const closeRequest = requestedOperation(
    4,
    'RELEASE',
    { target_claim_id: 'claim-test-001', from_state: 'CLAIMED' },
    owner,
    { reason: 'Close' },
  );
  const reclaimClaim = { ...next, request_sha: sha };
  const reclaimRequest = requestedOperation(
    7,
    'RECLAIM',
    { target_request_id: next.claim_id, claim: reclaimClaim },
    maintainer,
    { reason: 'Governed reclaim' },
  );
  const reclaimed = [
    ...first,
    closeRequest,
    reviewedOperation(
      5,
      'RELEASE',
      { from_state: 'CLAIMED', target_claim_id: 'claim-test-001' },
      closeRequest,
    ),
    event(6, 'CLAIM_REQUEST', { request: next }, ownerTwo),
    reclaimRequest,
    reviewedOperation(8, 'RECLAIM', { claim: reclaimClaim }, reclaimRequest, reviewerTwo),
  ];
  assert.deepEqual(replayEvidence(item('CLAIMED'), reclaimed, new Date(), principals()).errors, []);
  const selfReviewed = structuredClone(reclaimed);
  selfReviewed[7].actor = maintainer;
  selfReviewed[7].review = maintainer;
  assert.match(replayEvidence(item('CLAIMED'), selfReviewed, new Date(), principals()).errors.join('\n'), /independent/);
});

test('operation requests authenticate initiators and reject mismatch, reuse, and stale review', () => {
  const renewal = {
    claim_id: 'claim-test-001',
    principal: owner.principal,
    github_actor: owner.github_actor,
    expires_at: '2031-01-01T00:00:00Z',
    ...structuredClone(baseScope),
  };
  const requestEvent = requestedOperation(4, 'RENEW', {
    target_claim_id: renewal.claim_id,
    renewal,
  });
  const reviewedEvent = reviewedOperation(5, 'RENEW', { renewal }, requestEvent);
  assert.deepEqual(
    replayEvidence(
      item('CLAIMED'),
      [...activationPrefix(), requestEvent, reviewedEvent],
      new Date(),
      principals(),
    ).errors,
    [],
  );

  const forgedOwner = structuredClone(requestEvent);
  forgedOwner.actor = reviewer;
  assert.match(
    replayEvidence(
      item('CLAIMED'),
      [...activationPrefix(), forgedOwner, reviewedEvent],
      new Date(),
      principals(),
    ).errors.join('\n'),
    /authored by its exact operation actor|fresh prior operation request/,
  );

  const forgedO1 = requestedOperation(
    4,
    'RECLAIM',
    { target_request_id: 'claim-test-002', claim: activationPrefix()[2].claim },
    maintainer,
  );
  forgedO1.actor = reviewer;
  assert.match(
    replayEvidence(
      item('CLAIMED'),
      [...activationPrefix(), forgedO1],
      new Date(),
      principals(),
    ).errors.join('\n'),
    /authored by its exact operation actor/,
  );

  const mismatch = structuredClone(reviewedEvent);
  mismatch.renewal.expires_at = '2032-01-01T00:00:00Z';
  assert.match(
    replayEvidence(
      item('CLAIMED'),
      [...activationPrefix(), requestEvent, mismatch],
      new Date(),
      principals(),
    ).errors.join('\n'),
    /exactly consume one fresh prior operation request/,
  );

  const reused = [
    ...activationPrefix(),
    requestEvent,
    reviewedEvent,
    { ...reviewedEvent, sequence: 6, event_id: 'event-006', occurred_at: time(6) },
  ];
  assert.match(
    replayEvidence(item('CLAIMED'), reused, new Date(), principals()).errors.join('\n'),
    /exactly consume one fresh prior operation request/,
  );

  const staleRequest = requestedOperation(4, 'RENEW', {
    target_claim_id: renewal.claim_id,
    renewal,
  });
  const staleReview = reviewedOperation(6, 'RENEW', { renewal }, staleRequest);
  assert.match(
    replayEvidence(
      item('IN_REVIEW'),
      [
        ...activationPrefix(),
        staleRequest,
        event(5, 'STATE_TRANSITION', { from_state: 'CLAIMED', to_state: 'IN_REVIEW' }),
        staleReview,
      ],
      new Date(),
      principals(),
    ).errors.join('\n'),
    /exactly consume one fresh prior operation request/,
  );
});

test('full clean-room DONE keeps the claim through exact acceptance and rejects reorder/self-review/check gaps', () => {
  const flow = [
    ...activationPrefix(),
    event(4, 'STATE_TRANSITION', { from_state: 'CLAIMED', to_state: 'IN_REVIEW' }),
    event(5, 'REVIEW', { review: reviewer, reviewed_sha: sha }, reviewer),
    event(
      6,
      'PROVENANCE_ATTESTATION',
      { provenance: { attestation: 'independently-authored', redacted: true } },
      owner,
    ),
    event(
      7,
      'PROVENANCE_REVIEW',
      { review: humanReviewer, reviewed_sha: sha, provenance: { redacted: true } },
      humanReviewer,
    ),
    event(8, 'ACCEPTANCE', {
      acceptance: {
        tested_sha: sha,
        merged_sha: sha,
        checks: [
          { name: 'governance', status: 'passed' },
          { name: 'tests', status: 'passed' },
        ],
      },
    }),
    event(9, 'STATE_TRANSITION', { from_state: 'IN_REVIEW', to_state: 'DONE' }),
  ];
  assert.deepEqual(
    replayEvidence(item('DONE', { clean: true }), flow, new Date(), principals()).errors,
    [],
  );

  const selfReview = structuredClone(flow);
  selfReview[6].actor = owner;
  selfReview[6].review = owner;
  assert.match(replayEvidence(item('DONE', { clean: true }), selfReview, new Date(), principals()).errors.join('\n'), /registered human|independent/);

  const missingCheck = structuredClone(flow);
  missingCheck[7].acceptance.checks.pop();
  assert.match(replayEvidence(item('DONE', { clean: true }), missingCheck, new Date(), principals()).errors.join('\n'), /every required passed check|DONE requires/);

  const wrongSha = structuredClone(flow);
  wrongSha[7].acceptance.merged_sha = 'b'.repeat(40);
  assert.match(replayEvidence(item('DONE', { clean: true }), wrongSha, new Date(), principals()).errors.join('\n'), /exact SHA|DONE requires/);

  const reordered = structuredClone(flow);
  [reordered[6], reordered[7]] = [reordered[7], reordered[6]];
  reordered.forEach((value, index) => {
    value.sequence = index + 1;
    value.event_id = `reordered-${String(index + 1).padStart(3, '0')}`;
    value.occurred_at = time(index + 1);
  });
  assert.match(replayEvidence(item('DONE', { clean: true }), reordered, new Date(), principals()).errors.join('\n'), /acceptance requires/);

  const afterDone = [
    ...flow,
    event(
      10,
      'WORK_ITEM_AMENDMENT',
      {
        before_metadata_sha256: 'a'.repeat(64),
        after_metadata_sha256: 'b'.repeat(64),
        operation_actor: operationAgent,
        review: reviewer,
        reason: 'Forbidden terminal amendment',
      },
      reviewer,
    ),
  ];
  assert.match(
    replayEvidence(item('DONE', { clean: true }), afterDone, new Date(), principals()).errors.join('\n'),
    /amendment is forbidden after a terminal transition/,
  );

  const afterCancelled = [
    event(1, 'STATE_TRANSITION', { from_state: 'PROPOSED', to_state: 'CANCELLED' }),
    event(
      2,
      'WORK_ITEM_AMENDMENT',
      {
        before_metadata_sha256: 'a'.repeat(64),
        after_metadata_sha256: 'b'.repeat(64),
        operation_actor: operationAgent,
        review: reviewer,
        reason: 'Forbidden cancelled amendment',
      },
      reviewer,
    ),
  ];
  assert.match(
    replayEvidence(item('CANCELLED'), afterCancelled, new Date(), principals()).errors.join('\n'),
    /amendment is forbidden after a terminal transition/,
  );
});

test('ledger detects missing dependencies, cycles, readiness, global IDs, and active overlap', () => {
  const setup = ledgerFixture();
  try {
    writeItem(join(setup.path, 'work/items/A-1.md'), item('PROPOSED', { id: 'A-1', dependencies: ['MISSING-1'] }));
    let ledger = loadLedger(setup.path);
    assert.match(ledger.errors.join('\n'), /missing dependency/);

    rmSync(join(setup.path, 'work/items'), { recursive: true });
    rmSync(join(setup.path, 'work/evidence'), { recursive: true });
    mkdirSync(join(setup.path, 'work/items'));
    mkdirSync(join(setup.path, 'work/evidence'));
    writeItem(join(setup.path, 'work/items/A-1.md'), item('PROPOSED', { id: 'A-1', dependencies: ['B-1'] }));
    writeItem(join(setup.path, 'work/items/B-1.md'), item('PROPOSED', { id: 'B-1', dependencies: ['A-1'] }));
    ledger = loadLedger(setup.path);
    assert.match(ledger.errors.join('\n'), /dependency cycle/);

    const ready = item('READY', { id: 'B-1', dependencies: ['A-1'] });
    writeItem(join(setup.path, 'work/items/B-1.md'), ready);
    const transition = event(1, 'STATE_TRANSITION', { from_state: 'PROPOSED', to_state: 'READY' }, owner, 'B-1');
    writeCanonical(join(setup.path, 'work/evidence/B-1/0001-event-001.json'), transition);
    ledger = loadLedger(setup.path);
    assert.match(ledger.errors.join('\n'), /not satisfied/);

    rmSync(join(setup.path, 'work/items'), { recursive: true });
    rmSync(join(setup.path, 'work/evidence'), { recursive: true });
    mkdirSync(join(setup.path, 'work/items'));
    mkdirSync(join(setup.path, 'work/evidence'));
    for (const [id, suffix] of [
      ['A-1', 'a'],
      ['B-1', 'b'],
    ]) {
      writeItem(join(setup.path, `work/items/${id}.md`), item('CLAIMED', { id }));
      const wanted = request({ claimId: `claim-${suffix}-001` });
      const events = [
        { ...event(1, 'STATE_TRANSITION', { from_state: 'PROPOSED', to_state: 'READY' }, owner, id), event_id: `shared-event-001` },
        { ...event(2, 'CLAIM_REQUEST', { request: wanted }, owner, id), event_id: `${suffix}-event-002` },
        { ...event(3, 'CLAIM', { claim: { ...wanted, request_sha: sha } }, owner, id), event_id: `${suffix}-event-003` },
      ];
      for (const value of events) {
        writeCanonical(
          join(
            setup.path,
            `work/evidence/${id}/${String(value.sequence).padStart(4, '0')}-${value.event_id}.json`,
          ),
          value,
        );
      }
    }
    ledger = loadLedger(setup.path, { now: new Date('2026-08-08T00:01:00Z') });
    assert.match(ledger.errors.join('\n'), /event ID duplicates/);
    assert.match(ledger.errors.join('\n'), /active claims overlap/);
  } finally {
    setup.done();
  }
});

test('malformed active records report deterministic replay errors without overlap crashes', () => {
  const setup = ledgerFixture();
  try {
    writeItem(join(setup.path, 'work/items/A-1.md'), item('CLAIMED', { id: 'A-1' }));
    writeItem(join(setup.path, 'work/items/B-1.md'), item('CLAIMED', { id: 'B-1' }));
    let ledger;
    assert.doesNotThrow(() => {
      ledger = loadLedger(setup.path);
    });
    assert.match(ledger.errors.join('\n'), /A-1: replayed state differs|A-1: owned state requires/);
    assert.match(ledger.errors.join('\n'), /B-1: replayed state differs|B-1: owned state requires/);
  } finally {
    setup.done();
  }
});

test('full Git mode fails without a base and explicit local-ledger-only mode is truthful', () => {
  const full = command(
    root,
    process.execPath,
    ['scripts/governance/validate.mjs', '--now', '2026-08-08T00:10:00Z'],
    { GOVERNANCE_BASE_SHA: '', GITHUB_EVENT_NAME: '' },
  );
  assertRejected(full, /GOVERNANCE_BASE_SHA is required for full Git-context validation/, 'no-base full mode');
  assert.doesNotMatch(`${full.stdout}\n${full.stderr}`, /Git context not evaluated/);

  const local = command(
    root,
    process.execPath,
    [
      'scripts/governance/validate.mjs',
      '--local-ledger-only',
      '--now',
      '2026-08-08T00:10:00Z',
    ],
    { GOVERNANCE_BASE_SHA: '', GITHUB_EVENT_NAME: '' },
  );
  assertPassed(local, 'explicit local-ledger-only mode');
  assert.match(local.stdout, /Git context not evaluated \(--local-ledger-only\)\./);

  const workflowText = readFileSync(join(root, '.github/workflows/governance.yml'), 'utf8');
  const workflow = YAML.parseDocument(workflowText).toJS();
  const triggers = workflow.on ?? workflow.true;
  assert.deepEqual(triggers.push.branches, ['main']);
  assert.equal(workflow.jobs.coordination.steps.some((step) => step.run === 'npm run validate:governance:git'), true);
  const submittedRevision = '${{ github.event.pull_request.head.sha || github.sha }}';
  for (const jobName of ['repository-baseline', 'coordination']) {
    const checkout = workflow.jobs[jobName].steps.find((step) =>
      step.uses?.startsWith('actions/checkout@'),
    );
    assert.equal(checkout.with.ref, submittedRevision, `${jobName} checkout ref`);
    assert.equal(checkout.with['fetch-depth'], 0, `${jobName} full history`);
  }
  assert.equal(
    workflow.jobs.coordination.steps.find(
      (step) => step.run === 'npm run validate:governance:git',
    ).env.GOVERNANCE_BASE_SHA,
    '${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha || github.event.before }}',
  );
  assert.doesNotMatch(workflowText, /refs\/pull\/|pull\/[^\s]+\/merge/iu);

  const creationPush = command(
    root,
    process.execPath,
    ['scripts/governance/validate.mjs', '--now', '2026-08-08T00:10:00Z'],
    {
      GOVERNANCE_BASE_SHA: '0'.repeat(40),
      GITHUB_EVENT_NAME: 'push',
    },
  );
  assertRejected(
    creationPush,
    /repository-creation push has no comparable base; full Git-context validation fails closed/,
    'repository creation push',
  );
});

test('scope grammar, api/apiary boundaries, glob rules, and exact resume are enforced', () => {
  assert.equal(validScopePath('apps/api/**'), true);
  for (const path of ['apps/**/api', 'apps/a?i', '../apps/api', 'apps/*', '/apps/api']) {
    assert.equal(validScopePath(path), false, path);
  }
  assert.equal(pathsOverlap('apps/api/**', 'apps/api/file.mjs'), true);
  assert.equal(pathsOverlap('apps/api/**', 'apps/apiary/file.mjs'), false);

  const branch = git(root, ['branch', '--show-current']);
  const head = git(root, ['rev-parse', 'HEAD']);
  const claim = {
    ...request({ branch, worktree: worktreeBinding(root) }),
    request_sha: head,
  };
  const candidate = {
    root,
    claim_id: claim.claim_id,
    branch: claim.branch,
    principal: claim.principal,
    github_actor: claim.github_actor,
    worktree: claim.worktree,
    packages: claim.packages,
    paths: claim.paths,
    exclusive_resources: claim.exclusive_resources,
  };
  assert.deepEqual(verifyResumeWorktree(root, claim, candidate), []);
  assert.match(
    verifyResumeWorktree(root, claim, { ...candidate, resources: [], paths: ['tests/unit/**'] }).join('\n'),
    /differ/,
  );

  const setup = mkdtempSync('/var/tmp/autorepo-worktree-binding-');
  const primary = join(setup, 'primary');
  const linked = join(setup, 'linked');
  try {
    git(setup, ['clone', '--shared', root, primary]);
    git(primary, ['worktree', 'add', '-b', 'linked-binding-test', linked]);
    const linkedClaim = {
      ...claim,
      branch: 'linked-binding-test',
      request_sha: git(linked, ['rev-parse', 'HEAD']),
      worktree: worktreeBinding(primary),
    };
    const linkedCandidate = {
      ...candidate,
      root: linked,
      branch: linkedClaim.branch,
      worktree: linkedClaim.worktree,
    };
    assert.match(
      verifyResumeWorktree(linked, linkedClaim, linkedCandidate).join('\n'),
      /worktree binding does not match/,
    );
  } finally {
    rmSync(setup, { recursive: true, force: true });
  }
});

test('stateful fakes cover create/update/no-op/failure/drift and cannot reverse-mutate input', () => {
  for (const Fake of [JiraProjectionFake, ConfluenceRenderFake]) {
    const fake = new Fake();
    const input = { id: 'SYNTHETIC-1', title: 'Synthetic title', state: 'READY', dependencies: [] };
    const original = structuredClone(input);
    assert.equal(fake.preview(input).action, 'created');
    assert.equal(fake.preview(input).action, 'noop');
    input.title = 'Changed canonical title';
    assert.equal(fake.preview(input).action, 'updated');
    fake.tamper(input.id, { state: 'DONE' });
    assert.equal(fake.reconcile(input).action, 'updated');
    const inspection = fake.inspect(input.id);
    inspection.state = 'CANCELLED';
    assert.notEqual(fake.inspect(input.id).state, 'CANCELLED');
    fake.failNext();
    assert.throws(() => fake.preview(input), /fake failure/);
    assert.deepEqual(original, { id: 'SYNTHETIC-1', title: 'Synthetic title', state: 'READY', dependencies: [] });
  }
  assert.match(runtimeBoundaryDescription(), /Transport-surface absence|network denial/);
  assert.deepEqual(validateIntegrationBoundary(root), []);
  const runtime = runRuntimeTransportDenialHarness(root);
  assert.equal(runtime.status, 0, runtime.output);
  assert.match(runtime.output, /in-process monkeypatching, not OS\/network namespace denial/);
});

test('integration structural boundary rejects symlinks, unknown code, transport, and live dependencies', () => {
  const setup = mkdtempSync('/var/tmp/autorepo-integration-test-');
  try {
    for (const path of ['integrations', 'scripts/integrations', '.github/workflows']) {
      cpSync(join(root, path), join(setup, path), { recursive: true });
    }
    cpSync(join(root, 'package.json'), join(setup, 'package.json'));
    cpSync(join(root, 'package-lock.json'), join(setup, 'package-lock.json'));
    writeFileSync(join(setup, 'integrations/jira/live.py'), 'print("live")\n');
    writeFileSync(join(setup, 'integrations/fakes/network.mjs'), 'export const call = () => fetch("https://example.invalid");\n');
    symlinkSync('work-item.json', join(setup, 'integrations/jira/fixtures/link.json'));
    const packageJson = JSON.parse(readFileSync(join(setup, 'package.json')));
    const packageLock = JSON.parse(readFileSync(join(setup, 'package-lock.json')));
    packageJson.dependencies.axios = '1.0.0';
    packageLock.packages[''].dependencies.axios = '1.0.0';
    writeCanonical(join(setup, 'package.json'), packageJson);
    writeCanonical(join(setup, 'package-lock.json'), packageLock);
    assert.match(
      validateIntegrationBoundary(setup).join('\n'),
      /symlinks are forbidden|executable code extension|network transport call|dependency axios/,
    );
  } finally {
    rmSync(setup, { recursive: true, force: true });
  }
});

test('integration boundary scans JSON, Markdown, and every neutrally named workflow', () => {
  const setup = mkdtempSync('/var/tmp/autorepo-integration-text-test-');
  try {
    for (const path of ['integrations', 'scripts/integrations', '.github/workflows']) {
      cpSync(join(root, path), join(setup, path), { recursive: true });
    }
    cpSync(join(root, 'package.json'), join(setup, 'package.json'));
    cpSync(join(root, 'package-lock.json'), join(setup, 'package-lock.json'));
    assert.deepEqual(validateIntegrationBoundary(setup), []);

    const fixturePath = join(setup, 'integrations/jira/fixtures/work-item.json');
    const originalFixture = readFileSync(fixturePath, 'utf8');
    const fixture = JSON.parse(originalFixture);
    fixture.token = 'synthetic-not-a-secret';
    fixture.provider_url = 'https://synthetic.atlassian.invalid';
    fixture.command = 'publish';
    writeCanonical(fixturePath, fixture);
    assert.match(
      validateIntegrationBoundary(setup).join('\n'),
      /credential key|provider destination key|provider URL surface|live delivery command/,
    );
    writeFileSync(fixturePath, originalFixture);

    const readmePath = join(setup, 'integrations/confluence/README.md');
    const originalReadme = readFileSync(readmePath, 'utf8');
    writeFileSync(
      readmePath,
      `${originalReadme}\ntoken: synthetic\nProvider: https://synthetic.atlassian.invalid\nRun: npm run publish\n`,
    );
    assert.match(
      validateIntegrationBoundary(setup).join('\n'),
      /credential configuration surface|provider URL surface|live delivery command/,
    );
    writeFileSync(readmePath, originalReadme);

    writeFileSync(
      join(setup, '.github/workflows/neutral.yml'),
      'name: neutral\non: push\njobs:\n  neutral:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: npm run deploy\n',
    );
    assert.match(
      validateIntegrationBoundary(setup).join('\n'),
      /.github\/workflows\/neutral.yml: forbidden live delivery command/,
    );
  } finally {
    rmSync(setup, { recursive: true, force: true });
  }
});

test('repository-wide integration scan rejects root live providers and nested workspace manifests', () => {
  const setup = mkdtempSync('/var/tmp/autorepo-repository-surface-test-');
  try {
    for (const name of readdirSync(root)) {
      if (name === '.git' || name === 'node_modules') continue;
      cpSync(join(root, name), join(setup, name), { recursive: true });
    }
    mkdirSync(join(setup, 'scripts/providers'), { recursive: true });
    writeFileSync(
      join(setup, 'scripts/providers/jira-live.mjs'),
      "export const deliver = () => fetch('https://synthetic.atlassian.invalid');\n",
    );
    mkdirSync(join(setup, 'packages/synthetic'), { recursive: true });
    writeCanonical(join(setup, 'packages/synthetic/package.json'), {
      name: '@autorepo/synthetic',
      private: true,
      scripts: { deploy: 'node live.mjs' },
      dependencies: { axios: '1.0.0' },
    });
    assert.match(
      validateIntegrationBoundary(setup).join('\n'),
      /unapproved repository executable integration\/provider surface|network transport call|forbidden live\/apply script|forbidden network\/Atlassian\/live client/,
    );
  } finally {
    rmSync(setup, { recursive: true, force: true });
  }
});

test('repository-wide provider indicators catch camel-case Jira clients and neutral package scripts', () => {
  const setup = mkdtempSync('/var/tmp/autorepo-provider-indicator-test-');
  try {
    for (const name of readdirSync(root)) {
      if (name === '.git' || name === 'node_modules') continue;
      cpSync(join(root, name), join(setup, name), { recursive: true });
    }
    mkdirSync(join(setup, 'scripts'), { recursive: true });
    writeFileSync(
      join(setup, 'scripts/jiraClient.mjs'),
      'export const JiraClient = () => fetch(process.env.JIRA_URL)\n',
    );
    const packageJson = JSON.parse(readFileSync(join(setup, 'package.json')));
    packageJson.scripts.neutral = 'node scripts/jiraClient.mjs';
    writeCanonical(join(setup, 'package.json'), packageJson);
    assert.match(
      validateIntegrationBoundary(setup).join('\n'),
      /scripts\/jiraClient\.mjs: unapproved repository executable integration\/provider surface/,
    );
    assert.match(
      validateIntegrationBoundary(setup).join('\n'),
      /scripts\/jiraClient\.mjs: forbidden network transport call/,
    );
    assert.match(
      validateIntegrationBoundary(setup).join('\n'),
      /package\.json: unapproved package script integration\/provider surface neutral/,
    );
  } finally {
    rmSync(setup, { recursive: true, force: true });
  }
});

test('authenticated reviewer PR is required for new review evidence; history and merge-group replay are not rebound', { timeout: 120_000 }, () => {
  const setup = syntheticBootstrap();
  try {
    const history = buildClaimedHistory(setup);
    writeFileSync(join(setup.path, 'governance/authorship-implementation.mjs'), 'export const implemented = true;\n');
    const implementation = commitAll(setup.path, 'synthetic authorship implementation');
    assertPassed(
      runValidator(setup.path, history.activation, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      'owner implementation PR',
    );
    updateItem(setup.path, (metadata) => {
      metadata.state = 'IN_REVIEW';
    });
    addG2aEvent(
      setup.path,
      g2aEvent(4, 'STATE_TRANSITION', { from_state: 'CLAIMED', to_state: 'IN_REVIEW' }),
    );
    regenerate(setup.path);
    const reviewTransition = commitAll(setup.path, 'synthetic authorship review transition');
    assertPassed(
      runValidator(setup.path, implementation, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      'owner review transition PR',
    );

    addG2aEvent(
      setup.path,
      g2aEvent(5, 'REVIEW', { review: reviewer, reviewed_sha: implementation }, reviewer),
    );
    const reviewCommit = commitAll(setup.path, 'synthetic reviewer evidence');
    assertRejected(
      runValidator(setup.path, reviewTransition, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      /does not match authenticated PR actor/,
      'claimant cannot fabricate reviewer event',
    );
    assertPassed(
      runValidator(setup.path, reviewTransition, {
        GITHUB_ACTOR: reviewer.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      'authenticated reviewer PR',
    );
    git(setup.path, ['branch', 'review-evidence-source', reviewCommit]);
    git(setup.path, ['checkout', '-B', 'review-evidence-queue', reviewTransition]);
    git(setup.path, [
      'merge',
      '--no-ff',
      'review-evidence-source',
      '-m',
      'synthetic review evidence queue merge',
    ]);
    assertPassed(
      runValidator(setup.path, reviewTransition, {
        GITHUB_EVENT_NAME: 'merge_group',
        GITHUB_ACTOR: 'github-merge-queue',
        GITHUB_HEAD_REF: '',
      }),
      'merge-group deterministic replay without queue actor binding',
    );
    git(setup.path, ['checkout', 'synthetic']);
    git(setup.path, ['reset', '--hard', reviewCommit]);

    writeFileSync(join(setup.path, 'governance/authorship-after-review.mjs'), 'export const afterReview = true;\n');
    commitAll(setup.path, 'synthetic implementation after historical review');
    assertRejected(
      runValidator(setup.path, reviewCommit, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      /claimed implementation changed after reviewed SHA/,
      'historical reviewer identity is not rebound, but later implementation stales its reviewed SHA',
    );

    git(setup.path, ['reset', '--hard', reviewTransition]);
    const compactReview = g2aEvent(
      5,
      'REVIEW',
      { review: reviewer, reviewed_sha: implementation },
      reviewer,
    );
    const compactPath = join(setup.path, 'work/evidence/G2A/0005-event-005.json');
    mkdirSync(resolve(compactPath, '..'), { recursive: true });
    writeFileSync(compactPath, JSON.stringify(compactReview));
    commitAll(setup.path, 'synthetic noncanonical review blob');
    assertRejected(
      runValidator(setup.path, reviewTransition, {
        GITHUB_ACTOR: reviewer.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      /canonical formatting|exact canonical event blob/,
      'current evidence path must bind exact canonical blob',
    );
  } finally {
    setup.done();
  }
});

test('activation PR is activation-only and implementation starts from a base containing activation', { timeout: 120_000 }, () => {
  const setup = syntheticBootstrap();
  try {
    const history = buildClaimedHistory(setup);
    assert.ok(history.activation);
    git(setup.path, ['reset', '--hard', history.requestCommit]);
    updateItem(setup.path, (metadata) => {
      metadata.state = 'CLAIMED';
    });
    addG2aEvent(
      setup.path,
      g2aEvent(3, 'CLAIM', { claim: { ...history.wanted, request_sha: history.requestCommit } }),
    );
    writeFileSync(join(setup.path, 'governance/implementation-in-activation.mjs'), 'export const bypass = true;\n');
    regenerate(setup.path);
    commitAll(setup.path, 'synthetic activation with implementation');
    assertRejected(
      runValidator(setup.path, history.requestCommit, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      /activation diff is not activation-only|implementation base must already contain/,
      'activation cannot carry implementation',
    );
  } finally {
    setup.done();
  }
});

test('operation request and reviewed operation require separate authenticated PR bases', { timeout: 120_000 }, () => {
  const setup = syntheticBootstrap();
  try {
    const history = buildClaimedHistory(setup);
    const renewal = {
      claim_id: history.wanted.claim_id,
      principal: history.wanted.principal,
      github_actor: history.wanted.github_actor,
      expires_at: '2031-01-01T00:00:00Z',
      packages: history.wanted.packages,
      paths: history.wanted.paths,
      exclusive_resources: history.wanted.exclusive_resources,
    };
    const operationRequest = requestedOperation(
      4,
      'RENEW',
      { target_claim_id: history.wanted.claim_id, renewal },
      owner,
      { itemId: 'G2A', reason: 'Extend exact active lease' },
    );
    addG2aEvent(setup.path, operationRequest);
    const operationRequestCommit = commitAll(setup.path, 'synthetic owner operation request');
    assertPassed(
      runValidator(setup.path, history.activation, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      'owner operation request PR',
    );

    addG2aEvent(
      setup.path,
      reviewedOperation(5, 'RENEW', { renewal }, operationRequest, reviewer, {
        itemId: 'G2A',
        requestSha: operationRequestCommit,
      }),
    );
    commitAll(setup.path, 'synthetic independently reviewed renewal');
    assertRejected(
      runValidator(setup.path, history.activation, {
        GITHUB_ACTOR: reviewer.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      /reviewed operation base must already contain|does not match authenticated PR actor/,
      'request and review cannot share one PR base',
    );
    assertPassed(
      runValidator(setup.path, operationRequestCommit, {
        GITHUB_ACTOR: reviewer.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      'separate authenticated reviewer PR',
    );
  } finally {
    setup.done();
  }
});

test('DONE accepted SHA is structurally bounded by activation, acceptance, and terminal implementation range', { timeout: 120_000 }, () => {
  const setup = syntheticBootstrap();
  try {
    const reviewed = buildReviewedHistory(setup);
    git(setup.path, ['reset', '--hard', reviewed.reviewTransition]);
    addG2aEvent(
      setup.path,
      g2aEvent(
        5,
        'REVIEW',
        { review: reviewer, reviewed_sha: reviewed.requestCommit },
        reviewer,
      ),
    );
    commitAll(setup.path, 'synthetic review citing pre-activation SHA');
    assertRejected(
      runValidator(setup.path, reviewed.reviewTransition, {
        GITHUB_ACTOR: reviewer.github_actor,
        GITHUB_HEAD_REF: reviewed.wanted.branch,
      }),
      /reviewed SHA must strictly descend from the active claim activation/,
      'review cannot cite pre-activation SHA',
    );
    git(setup.path, ['reset', '--hard', reviewed.reviewCommit]);

    function commitDone(acceptedSha, message, base = reviewed.reviewCommit) {
      updateItem(setup.path, (metadata) => {
        metadata.state = 'DONE';
      });
      addG2aEvent(
        setup.path,
        g2aEvent(6, 'ACCEPTANCE', {
          acceptance: {
            tested_sha: acceptedSha,
            merged_sha: acceptedSha,
            checks: [
              { name: 'governance / coordination', status: 'passed' },
              { name: 'governance / repository-baseline', status: 'passed' },
            ],
          },
        }),
      );
      addG2aEvent(
        setup.path,
        g2aEvent(7, 'STATE_TRANSITION', { from_state: 'IN_REVIEW', to_state: 'DONE' }),
      );
      command(setup.path, process.execPath, ['scripts/governance/generate-views.mjs']);
      commitAll(setup.path, message);
      return runValidator(setup.path, base, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: reviewed.wanted.branch,
      });
    }

    assertRejected(
      commitDone(reviewed.requestCommit, 'synthetic accepted request SHA before activation'),
      /acceptance requires active reviewed work|must descend from the claim activation commit/,
      'accepted request SHA before activation',
    );

    git(setup.path, ['reset', '--hard', reviewed.reviewCommit]);
    assertRejected(
      commitDone(setup.bootstrap, 'synthetic accepted original base SHA'),
      /acceptance requires active reviewed work|must descend from the claim activation commit/,
      'accepted original base SHA',
    );

    git(setup.path, ['reset', '--hard', reviewed.reviewCommit]);
    git(setup.path, ['checkout', '-b', 'unrelated-accepted-sha', reviewed.activation]);
    writeFileSync(join(setup.path, 'unrelated-accepted.txt'), 'unrelated\n');
    const unrelated = commitAll(setup.path, 'synthetic unrelated accepted SHA');
    git(setup.path, ['checkout', 'synthetic']);
    git(setup.path, ['reset', '--hard', reviewed.reviewCommit]);
    assertRejected(
      commitDone(unrelated, 'synthetic unrelated DONE acceptance'),
      /acceptance requires active reviewed work|existing current HEAD ancestor|ancestor of its acceptance event commit/,
      'unrelated accepted SHA',
    );

    git(setup.path, ['reset', '--hard', reviewed.reviewCommit]);
    writeFileSync(join(setup.path, 'governance/late-implementation.mjs'), 'export const late = true;\n');
    const lateImplementation = commitAll(setup.path, 'synthetic implementation after accepted SHA');
    assertRejected(
      runValidator(setup.path, reviewed.reviewCommit, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: reviewed.wanted.branch,
      }),
      /claimed implementation changed after reviewed SHA/,
      'implementation after review immediately stales the review',
    );
    assertRejected(
      commitDone(
        reviewed.implementation,
        'synthetic DONE omitting later implementation',
        lateImplementation,
      ),
      /claimed implementation changed after accepted SHA/,
      'implementation after accepted SHA before DONE',
    );
  } finally {
    setup.done();
  }
});

test('committed clean-room review binds work and provenance to one exact SHA through DONE', { timeout: 180_000 }, () => {
  const setup = syntheticBootstrap({ clean: true });
  try {
    assertPassed(runValidator(setup.path, knownBase), 'clean-room bootstrap');
    const history = buildClaimedHistory(setup);
    writeFileSync(
      join(setup.path, 'governance/clean-room-implementation.mjs'),
      'export const cleanRoom = true;\n',
    );
    const implementation = commitAll(setup.path, 'synthetic clean-room implementation');
    assertPassed(
      runValidator(setup.path, history.activation, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      'clean-room implementation',
    );

    updateItem(setup.path, (metadata) => {
      metadata.state = 'IN_REVIEW';
    });
    addG2aEvent(
      setup.path,
      g2aEvent(4, 'STATE_TRANSITION', { from_state: 'CLAIMED', to_state: 'IN_REVIEW' }),
    );
    regenerate(setup.path);
    const transition = commitAll(setup.path, 'synthetic clean-room review transition');
    assertPassed(
      runValidator(setup.path, implementation, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      'clean-room review transition',
    );

    addG2aEvent(
      setup.path,
      g2aEvent(5, 'REVIEW', { review: reviewer, reviewed_sha: implementation }, reviewer),
    );
    const reviewCommit = commitAll(setup.path, 'synthetic exact work review');
    assertPassed(
      runValidator(setup.path, transition, {
        GITHUB_ACTOR: reviewer.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      'exact work review',
    );

    addG2aEvent(
      setup.path,
      g2aEvent(
        6,
        'PROVENANCE_ATTESTATION',
        { provenance: { attestation: 'independently-authored', redacted: true } },
        owner,
      ),
    );
    const attestationCommit = commitAll(setup.path, 'synthetic clean-room attestation');
    assertPassed(
      runValidator(setup.path, reviewCommit, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      'clean-room author attestation',
    );

    addG2aEvent(
      setup.path,
      g2aEvent(
        7,
        'PROVENANCE_REVIEW',
        {
          review: governanceHumanReviewer,
          reviewed_sha: implementation,
          provenance: { redacted: true },
        },
        governanceHumanReviewer,
      ),
    );
    const provenanceReviewCommit = commitAll(setup.path, 'synthetic exact provenance review');
    assertPassed(
      runValidator(setup.path, attestationCommit, {
        GITHUB_ACTOR: governanceHumanReviewer.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      'exact provenance review',
    );

    writeFileSync(
      join(setup.path, 'governance/stale-provenance.mjs'),
      'export const stale = true;\n',
    );
    commitAll(setup.path, 'synthetic implementation staling provenance review');
    assertRejected(
      runValidator(setup.path, provenanceReviewCommit, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      /claimed implementation changed after reviewed SHA/,
      'later implementation stales provenance review',
    );
    git(setup.path, ['reset', '--hard', provenanceReviewCommit]);

    updateItem(setup.path, (metadata) => {
      metadata.state = 'DONE';
    });
    addG2aEvent(
      setup.path,
      g2aEvent(8, 'ACCEPTANCE', {
        acceptance: {
          tested_sha: implementation,
          merged_sha: implementation,
          checks: [
            { name: 'governance / coordination', status: 'passed' },
            { name: 'governance / repository-baseline', status: 'passed' },
          ],
        },
      }),
    );
    addG2aEvent(
      setup.path,
      g2aEvent(9, 'STATE_TRANSITION', { from_state: 'IN_REVIEW', to_state: 'DONE' }),
    );
    regenerate(setup.path);
    commitAll(setup.path, 'synthetic full clean-room DONE');
    assertPassed(
      runValidator(setup.path, provenanceReviewCommit, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      'full valid clean-room DONE',
    );
  } finally {
    setup.done();
  }
});

test('committed synthetic histories prove bootstrap, claim purity, activation, implementation ownership, and DONE', { timeout: 120_000 }, () => {
  const setup = syntheticBootstrap();
  try {
    assertPassed(runValidator(setup.path, knownBase), 'actual bootstrap commit');

    writeFileSync(join(setup.path, 'unclaimed-implementation.txt'), 'unclaimed\n');
    const unclaimed = commitAll(setup.path, 'synthetic unclaimed implementation');
    assertRejected(runValidator(setup.path, setup.bootstrap), /requires exactly one active claim/, 'post-bootstrap unclaimed change');
    git(setup.path, ['reset', '--hard', setup.bootstrap]);

    const history = buildClaimedHistory(setup);
    writeFileSync(join(setup.path, 'governance/synthetic-owned.mjs'), 'export const owned = true;\n');
    const implementation = commitAll(setup.path, 'synthetic claimed implementation');
    assertPassed(
      runValidator(setup.path, history.activation, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      'claimed implementation',
    );

    updateItem(setup.path, (metadata) => {
      metadata.state = 'IN_REVIEW';
    });
    addG2aEvent(setup.path, g2aEvent(4, 'STATE_TRANSITION', { from_state: 'CLAIMED', to_state: 'IN_REVIEW' }));
    regenerate(setup.path);
    const reviewTransition = commitAll(setup.path, 'synthetic review transition');
    assertPassed(
      runValidator(setup.path, implementation, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      'review transition',
    );

    addG2aEvent(
      setup.path,
      g2aEvent(5, 'REVIEW', { review: reviewer, reviewed_sha: implementation }, reviewer),
    );
    const reviewCommit = commitAll(setup.path, 'synthetic independent review');
    assertPassed(
      runValidator(setup.path, reviewTransition, {
        GITHUB_ACTOR: reviewer.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      'independent review PR',
    );

    updateItem(setup.path, (metadata) => {
      metadata.state = 'DONE';
    });
    addG2aEvent(
      setup.path,
      g2aEvent(6, 'ACCEPTANCE', {
        acceptance: {
          tested_sha: implementation,
          merged_sha: implementation,
          checks: [
            { name: 'governance / coordination', status: 'passed' },
            { name: 'governance / repository-baseline', status: 'passed' },
          ],
        },
      }),
    );
    addG2aEvent(setup.path, g2aEvent(7, 'STATE_TRANSITION', { from_state: 'IN_REVIEW', to_state: 'DONE' }));
    regenerate(setup.path);
    const doneCommit = commitAll(setup.path, 'synthetic exact DONE history');
    assertPassed(
      runValidator(setup.path, reviewCommit, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      'full committed DONE history',
    );

    const terminalChange = updateItem(setup.path, (metadata) => {
      metadata.title = 'Forbidden metadata change after DONE';
    });
    addG2aEvent(
      setup.path,
      g2aEvent(
        8,
        'WORK_ITEM_AMENDMENT',
        {
          before_metadata_sha256: metadataSha256(terminalChange.before),
          after_metadata_sha256: metadataSha256(terminalChange.after),
          operation_actor: operationAgent,
          review: reviewer,
          reason: 'Attempt terminal metadata amendment',
        },
        reviewer,
      ),
    );
    commitAll(setup.path, 'synthetic forbidden metadata amendment after DONE');
    assertRejected(
      runValidator(setup.path, doneCommit, { GITHUB_ACTOR: reviewer.github_actor }),
      /terminal work item and evidence records are immutable|metadata changes require/,
      'committed metadata amendment after DONE',
    );
  } finally {
    setup.done();
  }
});

test('current CI actor/ref checks ignore historical claims after a governed reclaim', { timeout: 120_000 }, () => {
  const setup = syntheticBootstrap();
  try {
    const first = buildClaimedHistory(setup);
    const second = buildReclaimedHistory(setup, first);
    writeFileSync(join(setup.path, 'governance/current-owner.mjs'), 'export const currentOwner = true;\n');
    commitAll(setup.path, 'synthetic current reclaimed owner implementation');
    assertPassed(
      runValidator(setup.path, second.reclaim, {
        GITHUB_ACTOR: ownerTwo.github_actor,
        GITHUB_HEAD_REF: second.next.branch,
      }),
      'historical activation actor/ref isolation',
    );
  } finally {
    setup.done();
  }
});

test('committed validator rejects evidence M/D/rename/type, stale base, generated drift, and amendment bypasses', { timeout: 120_000 }, () => {
  const setup = syntheticBootstrap();
  try {
    const history = buildClaimedHistory(setup);
    const activation = history.activation;

    const cases = [
      {
        name: 'modified evidence',
        mutate() {
          const path = join(setup.path, 'work/evidence/G2A/0001-event-001.json');
          const value = JSON.parse(readFileSync(path));
          value.reason = 'Changed after append';
          writeCanonical(path, value);
        },
        pattern: /append-only evidence violation: M/,
      },
      {
        name: 'deleted evidence',
        mutate() {
          rmSync(join(setup.path, 'work/evidence/G2A/0001-event-001.json'));
        },
        pattern: /append-only evidence violation: D/,
      },
      {
        name: 'renamed evidence',
        mutate() {
          const oldPath = join(setup.path, 'work/evidence/G2A/0001-event-001.json');
          const value = JSON.parse(readFileSync(oldPath));
          value.event_id = 'event-renamed-001';
          rmSync(oldPath);
          writeCanonical(join(setup.path, 'work/evidence/G2A/0001-event-renamed-001.json'), value);
        },
        pattern: /append-only evidence violation: D/,
      },
      {
        name: 'type-changed evidence',
        mutate() {
          const path = join(setup.path, 'work/evidence/G2A/0003-event-003.json');
          rmSync(path);
          symlinkSync('0002-event-002.json', path);
        },
        pattern: /append-only evidence violation: T/,
      },
      {
        name: 'generated drift',
        mutate() {
          writeFileSync(join(setup.path, 'work/views/status.md'), 'drift\n');
        },
        pattern: /generated output is not byte-exact/,
      },
    ];

    for (const probe of cases) {
      git(setup.path, ['reset', '--hard', activation]);
      git(setup.path, ['clean', '-fd']);
      probe.mutate();
      commitAll(setup.path, `synthetic ${probe.name}`);
      assertRejected(runValidator(setup.path, activation), probe.pattern, probe.name);
    }

    git(setup.path, ['reset', '--hard', activation]);
    const scopeChange = updateItem(setup.path, (metadata) => {
      metadata.scope.paths.push('outside/**');
    });
    addG2aEvent(
      setup.path,
      g2aEvent(
        4,
        'WORK_ITEM_AMENDMENT',
        {
          before_metadata_sha256: metadataSha256(scopeChange.before),
          after_metadata_sha256: metadataSha256(scopeChange.after),
          operation_actor: operationAgent,
          review: reviewer,
          reason: 'Illegal active expansion',
        },
        reviewer,
      ),
    );
    commitAll(setup.path, 'synthetic active scope expansion');
    assertRejected(runValidator(setup.path, activation), /active scope cannot expand|active claim scope/, 'scope expansion');

    git(setup.path, ['reset', '--hard', setup.bootstrap]);
    updateItem(setup.path, (metadata) => {
      metadata.title = 'Changed without amendment';
    });
    commitAll(setup.path, 'synthetic metadata bypass');
    assertRejected(runValidator(setup.path, setup.bootstrap), /metadata changes require/, 'missing amendment');

    git(setup.path, ['reset', '--hard', setup.bootstrap]);
    updateItem(setup.path, undefined, (body) => `${body}\nUnclaimed prose.\n`);
    commitAll(setup.path, 'synthetic prose bypass');
    assertRejected(runValidator(setup.path, setup.bootstrap), /prose may change only/, 'unclaimed prose');

    git(setup.path, ['reset', '--hard', activation]);
    updateItem(setup.path, undefined, (body) => `${body}\nClaimed prose by the wrong CI actor.\n`);
    commitAll(setup.path, 'synthetic claimed prose wrong actor');
    assertRejected(
      runValidator(setup.path, activation, {
        GITHUB_ACTOR: ownerTwo.github_actor,
        GITHUB_HEAD_REF: 'wrong-branch',
      }),
      /claimed change actor differs|claimed change branch differs/,
      'claimed item prose actor/ref binding',
    );

    git(setup.path, ['reset', '--hard', history.ready]);
    addG2aEvent(
      setup.path,
      g2aEvent(2, 'CLAIM_REQUEST', {
        request: request({
          claimId: 'claim-impure',
          baseSha: history.ready,
          worktree: worktreeBinding(setup.path),
          scope: parseWorkItemMarkdown(readFileSync(join(setup.path, 'work/items/G2A.md'))).metadata.scope,
        }),
      }),
    );
    writeFileSync(join(setup.path, 'governance/impure.txt'), 'extra\n');
    commitAll(setup.path, 'synthetic impure request');
    assertRejected(
      runValidator(setup.path, history.ready, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: 'synthetic',
      }),
      /claim request diff is not claim-only/,
      'claim purity',
    );

    git(setup.path, ['reset', '--hard', activation]);
    git(setup.path, ['checkout', '-b', 'sibling', history.requestCommit]);
    writeFileSync(join(setup.path, 'sibling.txt'), 'sibling\n');
    const sibling = commitAll(setup.path, 'synthetic sibling base');
    git(setup.path, ['checkout', 'synthetic']);
    git(setup.path, ['reset', '--hard', activation]);
    assertRejected(runValidator(setup.path, sibling), /stale or not a HEAD ancestor/, 'stale base');
  } finally {
    setup.done();
  }
});

test('per-commit validation rejects violation-then-restore histories and merge commits', { timeout: 180_000 }, () => {
  const setup = syntheticBootstrap();
  try {
    const history = buildClaimedHistory(setup);
    const evidencePath = 'work/evidence/G2A/0001-event-001.json';

    const originalEvidence = readFileSync(join(setup.path, evidencePath), 'utf8');
    const mutatedEvidence = JSON.parse(originalEvidence);
    mutatedEvidence.reason = 'temporary mutation';
    writeCanonical(join(setup.path, evidencePath), mutatedEvidence);
    commitAll(setup.path, 'synthetic temporary evidence mutation');
    writeFileSync(join(setup.path, evidencePath), originalEvidence);
    commitAll(setup.path, 'synthetic evidence restoration');
    assertRejected(
      runValidator(setup.path, history.activation, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      /append-only evidence violation|invalid closed event variant/,
      'evidence mutation cannot be hidden by restoration',
    );

    git(setup.path, ['reset', '--hard', history.activation]);
    writeFileSync(join(setup.path, 'outside-scope.txt'), 'temporary out of scope\n');
    commitAll(setup.path, 'synthetic temporary out-of-scope implementation');
    rmSync(join(setup.path, 'outside-scope.txt'));
    commitAll(setup.path, 'synthetic out-of-scope restoration');
    assertRejected(
      runValidator(setup.path, history.activation, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      /requires exactly one active claim in the parent ledger/,
      'out-of-scope implementation cannot be hidden by restoration',
    );

    git(setup.path, ['reset', '--hard', history.requestCommit]);
    updateItem(setup.path, (metadata) => {
      metadata.state = 'CLAIMED';
    });
    addG2aEvent(
      setup.path,
      g2aEvent(3, 'CLAIM', { claim: { ...history.wanted, request_sha: history.requestCommit } }),
    );
    writeFileSync(join(setup.path, 'outside-activation.txt'), 'temporary activation payload\n');
    regenerate(setup.path);
    commitAll(setup.path, 'synthetic impure activation transition');
    rmSync(join(setup.path, 'outside-activation.txt'));
    commitAll(setup.path, 'synthetic activation payload restoration');
    assertRejected(
      runValidator(setup.path, history.requestCommit, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      /activation diff is not activation-only|requires exactly one active claim in the parent ledger/,
      'activation impurity cannot be hidden by restoration',
    );

    git(setup.path, ['reset', '--hard', setup.bootstrap]);
    const reviewed = buildReviewedHistory(setup);
    updateItem(setup.path, (metadata) => {
      metadata.state = 'DONE';
    });
    addG2aEvent(
      setup.path,
      g2aEvent(6, 'ACCEPTANCE', {
        acceptance: {
          tested_sha: reviewed.implementation,
          merged_sha: reviewed.implementation,
          checks: [
            { name: 'governance / coordination', status: 'passed' },
            { name: 'governance / repository-baseline', status: 'passed' },
          ],
        },
      }),
    );
    addG2aEvent(
      setup.path,
      g2aEvent(7, 'STATE_TRANSITION', { from_state: 'IN_REVIEW', to_state: 'DONE' }),
    );
    regenerate(setup.path);
    const done = commitAll(setup.path, 'synthetic terminal baseline');
    assertPassed(
      runValidator(setup.path, reviewed.reviewCommit, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: reviewed.wanted.branch,
      }),
      'terminal baseline',
    );
    updateItem(setup.path, (metadata) => {
      metadata.title = 'Temporary terminal mutation';
    });
    commitAll(setup.path, 'synthetic temporary terminal mutation');
    git(setup.path, ['checkout', done, '--', 'work/items/G2A.md']);
    commitAll(setup.path, 'synthetic terminal restoration');
    assertRejected(
      runValidator(setup.path, done, { GITHUB_ACTOR: owner.github_actor }),
      /terminal work item and evidence records are immutable/,
      'terminal mutation cannot be hidden by restoration',
    );

    git(setup.path, ['reset', '--hard', history.activation]);
    git(setup.path, ['checkout', '-b', 'synthetic-side']);
    writeFileSync(join(setup.path, 'governance/side.mjs'), 'export const side = true;\n');
    commitAll(setup.path, 'synthetic side commit');
    git(setup.path, ['checkout', 'synthetic']);
    git(setup.path, ['reset', '--hard', history.activation]);
    writeFileSync(join(setup.path, 'governance/main.mjs'), 'export const main = true;\n');
    commitAll(setup.path, 'synthetic main commit');
    git(setup.path, ['merge', '--no-ff', 'synthetic-side', '-m', 'synthetic forbidden merge']);
    assertRejected(
      runValidator(setup.path, history.activation, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      /merge commits are forbidden|one linear chain/,
      'introduced merge commit',
    );
  } finally {
    setup.done();
  }
});

test('PR validates submitted head while merge_group validates its platform merge chain', { timeout: 180_000 }, () => {
  const setup = syntheticBootstrap();
  try {
    const history = buildClaimedHistory(setup);
    git(setup.path, ['checkout', '-b', 'submitted-pr-head', history.activation]);
    writeFileSync(
      join(setup.path, 'governance/submitted-head.mjs'),
      'export const submittedHead = true;\n',
    );
    const submittedHead = commitAll(setup.path, 'synthetic submitted PR head');
    assertPassed(
      runValidator(setup.path, history.activation, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      'submitted PR head is a strict linear revision',
    );

    git(setup.path, ['checkout', 'synthetic']);
    git(setup.path, ['reset', '--hard', history.activation]);
    git(setup.path, ['merge', '--no-ff', 'submitted-pr-head', '-m', 'synthetic queue merge']);
    const queueMerge = git(setup.path, ['rev-parse', 'HEAD']);
    assert.equal(git(setup.path, ['rev-parse', `${queueMerge}^1`]), history.activation);
    assert.equal(git(setup.path, ['rev-parse', `${queueMerge}^2`]), submittedHead);

    assertRejected(
      runValidator(setup.path, history.activation, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      /merge commits are forbidden/,
      'pull_request remains strict and would reject a synthetic pull merge revision',
    );
    assertPassed(
      runValidator(setup.path, history.activation, {
        GITHUB_EVENT_NAME: 'merge_group',
        GITHUB_ACTOR: 'github-merge-queue',
        GITHUB_HEAD_REF: '',
      }),
      'merge_group accepts exactly its terminal platform merge',
    );

    const workflow = YAML.parseDocument(
      readFileSync(join(setup.path, '.github/workflows/governance.yml'), 'utf8'),
    ).toJS();
    for (const jobName of ['repository-baseline', 'coordination']) {
      const checkout = workflow.jobs[jobName].steps.find((step) =>
        step.uses?.startsWith('actions/checkout@'),
      );
      assert.equal(
        checkout.with.ref,
        '${{ github.event.pull_request.head.sha || github.sha }}',
        `${jobName} selects submitted PR head instead of synthetic pull merge`,
      );
    }
  } finally {
    setup.done();
  }
});

test('merge_group accepts multiple queued pull requests in one platform merge chain', { timeout: 180_000 }, () => {
  const setup = syntheticBootstrap();
  try {
    const history = buildClaimedHistory(setup);
    git(setup.path, ['checkout', '-b', 'queued-pr-one', history.activation]);
    writeFileSync(
      join(setup.path, 'governance/queued-pr-one.mjs'),
      'export const queuedPrOne = true;\n',
    );
    const firstSource = commitAll(setup.path, 'synthetic first queued PR');
    assertPassed(
      runValidator(setup.path, history.activation, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      'first queued PR independently passes pull-request validation',
    );

    git(setup.path, ['checkout', 'synthetic']);
    git(setup.path, ['reset', '--hard', history.activation]);
    git(setup.path, ['merge', '--no-ff', 'queued-pr-one', '-m', 'synthetic first queue merge']);
    const firstMerge = git(setup.path, ['rev-parse', 'HEAD']);
    assert.equal(git(setup.path, ['rev-parse', `${firstMerge}^1`]), history.activation);
    assert.equal(git(setup.path, ['rev-parse', `${firstMerge}^2`]), firstSource);

    git(setup.path, ['checkout', '-b', 'queued-pr-two', history.activation]);
    writeFileSync(
      join(setup.path, 'governance/queued-pr-two.mjs'),
      'export const queuedPrTwo = true;\n',
    );
    const secondSource = commitAll(setup.path, 'synthetic second queued PR');
    assertPassed(
      runValidator(setup.path, history.activation, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      'second queued PR independently passes pull-request validation',
    );

    git(setup.path, ['checkout', 'synthetic']);
    git(setup.path, ['merge', '--no-ff', 'queued-pr-two', '-m', 'synthetic second queue merge']);
    const secondMerge = git(setup.path, ['rev-parse', 'HEAD']);
    assert.equal(git(setup.path, ['rev-parse', `${secondMerge}^1`]), firstMerge);
    assert.equal(git(setup.path, ['rev-parse', `${secondMerge}^2`]), secondSource);

    assertPassed(
      runValidator(setup.path, history.activation, {
        GITHUB_EVENT_NAME: 'merge_group',
        GITHUB_ACTOR: 'github-merge-queue',
        GITHUB_HEAD_REF: '',
      }),
      'merge_group accepts multiple queued PR platform merges',
    );
  } finally {
    setup.done();
  }
});

test('merge_group replays a later queued implementation against an earlier queued release', { timeout: 180_000 }, () => {
  const setup = syntheticBootstrap();
  try {
    const history = buildClaimedHistory(setup);
    const releaseRequest = requestedOperation(
      4,
      'RELEASE',
      { target_claim_id: history.wanted.claim_id, from_state: 'CLAIMED' },
      owner,
      { itemId: 'G2A', reason: 'Release before queued stale implementation' },
    );
    addG2aEvent(setup.path, releaseRequest);
    const queueBase = commitAll(setup.path, 'synthetic pre-queue release request');
    assertPassed(
      runValidator(setup.path, history.activation, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      'pre-queue release request',
    );

    git(setup.path, ['checkout', '-b', 'queued-release', queueBase]);
    updateItem(setup.path, (metadata) => {
      metadata.state = 'READY';
    });
    addG2aEvent(
      setup.path,
      reviewedOperation(
        5,
        'RELEASE',
        { from_state: 'CLAIMED', target_claim_id: history.wanted.claim_id },
        releaseRequest,
        reviewer,
        { itemId: 'G2A', requestSha: queueBase },
      ),
    );
    regenerate(setup.path);
    const releaseSource = commitAll(setup.path, 'synthetic queued release');
    assertPassed(
      runValidator(setup.path, queueBase, {
        GITHUB_ACTOR: reviewer.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      'queued release independently passes pull-request validation',
    );

    git(setup.path, ['checkout', '-b', 'queued-stale-implementation', queueBase]);
    writeFileSync(
      join(setup.path, 'governance/queued-stale-implementation.mjs'),
      'export const staleImplementation = true;\n',
    );
    const staleSource = commitAll(setup.path, 'synthetic queued stale implementation');
    assertPassed(
      runValidator(setup.path, queueBase, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      'stale implementation independently passes before the queued release',
    );

    git(setup.path, ['checkout', 'synthetic']);
    git(setup.path, ['reset', '--hard', queueBase]);
    git(setup.path, ['merge', '--no-ff', releaseSource, '-m', 'synthetic queued release merge']);
    git(setup.path, [
      'merge',
      '--no-ff',
      staleSource,
      '-m',
      'synthetic queued stale implementation merge',
    ]);
    assertRejected(
      runValidator(setup.path, queueBase, {
        GITHUB_EVENT_NAME: 'merge_group',
        GITHUB_ACTOR: 'github-merge-queue',
        GITHUB_HEAD_REF: '',
      }),
      /requires exactly one active claim in the parent ledger/,
      'later queued implementation is invalidated by earlier queued release',
    );
  } finally {
    setup.done();
  }
});

test('merge_group rejects extra non-platform history on its first-parent chain', { timeout: 180_000 }, () => {
  const setup = syntheticBootstrap();
  try {
    const history = buildClaimedHistory(setup);
    git(setup.path, ['checkout', '-b', 'queued-valid-source', history.activation]);
    writeFileSync(join(setup.path, 'governance/queued-valid.mjs'), 'export const valid = true;\n');
    commitAll(setup.path, 'synthetic valid queued source');

    git(setup.path, ['checkout', 'synthetic']);
    git(setup.path, ['reset', '--hard', history.activation]);
    git(setup.path, ['merge', '--no-ff', 'queued-valid-source', '-m', 'synthetic valid queue merge']);
    writeFileSync(join(setup.path, 'governance/unrelated-queue.mjs'), 'export const unrelated = true;\n');
    commitAll(setup.path, 'synthetic unrelated first-parent commit');

    assertRejected(
      runValidator(setup.path, history.activation, {
        GITHUB_EVENT_NAME: 'merge_group',
        GITHUB_ACTOR: 'github-merge-queue',
        GITHUB_HEAD_REF: '',
      }),
      /first-parent chain of two-parent platform merges/,
      'merge_group extra first-parent commit',
    );
  } finally {
    setup.done();
  }
});

test('merge_group detects review staleness introduced by a later platform merge', { timeout: 180_000 }, () => {
  const setup = syntheticBootstrap();
  try {
    const history = buildClaimedHistory(setup);
    writeFileSync(
      join(setup.path, 'governance/review-target.mjs'),
      'export const reviewTarget = true;\n',
    );
    const implementation = commitAll(setup.path, 'synthetic implementation before review queue');
    updateItem(setup.path, (metadata) => {
      metadata.state = 'IN_REVIEW';
    });
    addG2aEvent(
      setup.path,
      g2aEvent(4, 'STATE_TRANSITION', { from_state: 'CLAIMED', to_state: 'IN_REVIEW' }),
    );
    regenerate(setup.path);
    const queueBase = commitAll(setup.path, 'synthetic review queue base');

    git(setup.path, ['checkout', '-b', 'queued-review', queueBase]);
    addG2aEvent(
      setup.path,
      g2aEvent(5, 'REVIEW', { review: reviewer, reviewed_sha: implementation }, reviewer),
    );
    const reviewSource = commitAll(setup.path, 'synthetic queued review');
    assertPassed(
      runValidator(setup.path, queueBase, {
        GITHUB_ACTOR: reviewer.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      'queued review independently passes pull-request validation',
    );

    git(setup.path, ['checkout', '-b', 'queued-post-review-change', queueBase]);
    writeFileSync(
      join(setup.path, 'governance/post-review-change.mjs'),
      'export const postReviewChange = true;\n',
    );
    const lateSource = commitAll(setup.path, 'synthetic queued post-review implementation');
    assertPassed(
      runValidator(setup.path, queueBase, {
        GITHUB_ACTOR: owner.github_actor,
        GITHUB_HEAD_REF: history.wanted.branch,
      }),
      'later implementation independently passes before queued review exists',
    );

    git(setup.path, ['checkout', 'synthetic']);
    git(setup.path, ['reset', '--hard', queueBase]);
    git(setup.path, ['merge', '--no-ff', reviewSource, '-m', 'synthetic queued review merge']);
    git(setup.path, ['merge', '--no-ff', lateSource, '-m', 'synthetic queued late change merge']);
    assertRejected(
      runValidator(setup.path, queueBase, {
        GITHUB_EVENT_NAME: 'merge_group',
        GITHUB_ACTOR: 'github-merge-queue',
        GITHUB_HEAD_REF: '',
      }),
      /claimed implementation changed after reviewed SHA/,
      'later platform merge stales queued review',
    );
  } finally {
    setup.done();
  }
});

test('merge_group rejects an internal merge before its terminal platform merge', { timeout: 180_000 }, () => {
  const setup = syntheticBootstrap();
  try {
    const history = buildClaimedHistory(setup);
    git(setup.path, ['checkout', '-b', 'internal-side', history.activation]);
    writeFileSync(
      join(setup.path, 'governance/internal-side.mjs'),
      'export const internalSide = true;\n',
    );
    commitAll(setup.path, 'synthetic internal side');

    git(setup.path, ['checkout', '-b', 'internal-source', history.activation]);
    writeFileSync(
      join(setup.path, 'governance/internal-source.mjs'),
      'export const internalSource = true;\n',
    );
    commitAll(setup.path, 'synthetic internal source');
    git(setup.path, ['merge', '--no-ff', 'internal-side', '-m', 'synthetic forbidden internal merge']);

    git(setup.path, ['checkout', 'synthetic']);
    git(setup.path, ['reset', '--hard', history.activation]);
    git(setup.path, ['merge', '--no-ff', 'internal-source', '-m', 'synthetic terminal queue merge']);
    assertRejected(
      runValidator(setup.path, history.activation, {
        GITHUB_EVENT_NAME: 'merge_group',
        GITHUB_ACTOR: 'github-merge-queue',
        GITHUB_HEAD_REF: '',
      }),
      /merge commits are forbidden|linear source chain/,
      'merge_group internal merge',
    );
  } finally {
    setup.done();
  }
});
