import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { renderCodeowners } from '../../.github/scripts/generate-codeowners.mjs';
import {
  loadLedger,
  metadataSha256,
  parseWorkItemMarkdown,
  pathsOverlap,
} from './ledger.mjs';
import { generatedViews } from './generate-views.mjs';

const EVIDENCE_PREFIX = 'work/evidence/';
const GENERATED_PATHS = new Set([
  'work/views/status.md',
  'work/views/dependency-graph.md',
  '.github/CODEOWNERS',
]);
const CLOSURES = new Set(['RELEASE', 'HANDOFF', 'PAUSE', 'CANCEL_CLAIM']);
const REVIEWED_OPERATIONS = new Set([
  'RENEW',
  'RELEASE',
  'HANDOFF',
  'PAUSE',
  'CANCEL_CLAIM',
  'RECLAIM',
  'WORK_ITEM_AMENDMENT',
]);

function runGit(root, args, options = {}) {
  return spawnSync('git', args, {
    cwd: root,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

function gitLine(root, args) {
  const result = runGit(root, args);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function gitText(root, sha, path) {
  const result = runGit(root, ['show', `${sha}:${path}`]);
  return result.status === 0 ? result.stdout : undefined;
}

function commitExists(root, sha) {
  return runGit(root, ['cat-file', '-e', `${sha}^{commit}`]).status === 0;
}

function commitParents(root, sha) {
  const line = gitLine(root, ['rev-list', '--parents', '-n', '1', sha]);
  return line?.split(' ').slice(1) ?? [];
}

function introducedCommits(root, base, head) {
  const result = runGit(root, ['rev-list', '--reverse', '--topo-order', `${base}..${head}`]);
  return result.status === 0 ? result.stdout.split('\n').filter(Boolean) : undefined;
}

function ancestor(root, older, newer) {
  return runGit(root, ['merge-base', '--is-ancestor', older, newer]).status === 0;
}

function mergeBase(root, left, right) {
  return gitLine(root, ['merge-base', left, right]);
}

function statusDiff(root, base, head = 'HEAD', pathspec = []) {
  const result = runGit(root, [
    'diff',
    '--name-status',
    '--no-renames',
    `${base}..${head}`,
    ...(pathspec.length > 0 ? ['--', ...pathspec] : []),
  ]);
  if (result.status !== 0) return undefined;
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...names] = line.split('\t');
      return { status, path: names.at(-1), names };
    });
}

function eventPath(event) {
  return `work/evidence/${event.work_item_id}/${String(event.sequence).padStart(4, '0')}-${event.event_id}.json`;
}

function canonicalEvent(event) {
  return `${JSON.stringify(event, null, 2)}\n`;
}

function exactEventAt(root, sha, event) {
  return gitText(root, sha, eventPath(event)) === canonicalEvent(event);
}

function commitAddingPath(root, path) {
  const result = runGit(root, ['log', '--reverse', '--format=%H', '--diff-filter=A', '--', path]);
  return result.status === 0 ? result.stdout.split('\n').find(Boolean) : undefined;
}

function listTree(root, sha, pathspec) {
  const result = runGit(root, ['ls-tree', '-r', '--name-only', sha, '--', pathspec]);
  return result.status === 0 ? result.stdout.split('\n').filter(Boolean) : undefined;
}

function snapshotLedger(root, sha) {
  const directory = mkdtempSync(join(tmpdir(), 'autorepo-ledger-'));
  try {
    const paths = [
      ...(listTree(root, sha, 'work') ?? []),
      ...(listTree(root, sha, 'governance/owners.yaml') ?? []),
    ];
    for (const path of paths) {
      const content = gitText(root, sha, path);
      if (content === undefined) continue;
      const target = join(directory, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    if (!existsSync(join(directory, 'work/schema/work-item.schema.json'))) return undefined;
    return loadLedger(directory, { now: new Date(0) });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function expectedGenerated(ledger) {
  return new Map([...generatedViews(ledger.records), ['.github/CODEOWNERS', renderCodeowners()]]);
}

function generatedErrorsAt(root, sha, changedPaths, ledgerAtSha) {
  const errors = [];
  if (!ledgerAtSha) return [`${sha}: cannot reconstruct canonical ledger for generated output checks`];
  const expected = expectedGenerated(ledgerAtSha);
  for (const path of changedPaths.filter((entry) => GENERATED_PATHS.has(entry))) {
    if (gitText(root, sha, path) !== expected.get(path)) {
      errors.push(`${path}: generated exemption at ${sha} is not byte-exact`);
    }
  }
  return errors;
}

function generatedErrorsInWorktree(root, ledger) {
  const errors = [];
  for (const [path, expected] of expectedGenerated(ledger)) {
    if (!existsSync(join(root, path)) || readFileSync(join(root, path), 'utf8') !== expected) {
      errors.push(`${path}: generated output is not byte-exact`);
    }
  }
  return errors;
}

function sameIdentity(left, right) {
  return Boolean(
    left &&
      right &&
      left.principal === right.principal &&
      left.github_actor === right.github_actor,
  );
}

function identityConflicts(left, right) {
  return Boolean(
    left &&
      right &&
      (left.principal === right.principal || left.github_actor === right.github_actor),
  );
}

function sameArray(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function scopeCovers(scopePaths, path) {
  return scopePaths.some((scope) => pathsOverlap(scope, path));
}

export function worktreeBinding(path) {
  const realPath = realpathSync(resolve(path));
  const normalized = realPath === '/' ? realPath : realPath.replace(/\/+$/u, '');
  return `sha256:${createHash('sha256').update(normalized).digest('hex')}`;
}

function scopeExpanded(before, after) {
  return (
    after.packages.some((entry) => !before.packages.includes(entry)) ||
    after.paths.some((entry) => !before.paths.includes(entry)) ||
    after.exclusive_resources.some((entry) => !before.exclusive_resources.includes(entry))
  );
}

function metadataWithoutState(metadata) {
  const copy = structuredClone(metadata);
  delete copy.state;
  return copy;
}

function stateChangeExplained(beforeState, afterState, events, addedEventPaths) {
  return events.some((event) => {
    if (!addedEventPaths.has(eventPath(event))) return false;
    if (
      event.type === 'STATE_TRANSITION' &&
      event.from_state === beforeState &&
      event.to_state === afterState
    ) {
      return true;
    }
    if ((event.type === 'CLAIM' || event.type === 'RECLAIM') && beforeState === 'READY') {
      return afterState === 'CLAIMED';
    }
    if (!CLOSURES.has(event.type) || event.from_state !== beforeState) return false;
    const target =
      event.type === 'PAUSE' ? 'BLOCKED' : event.type === 'CANCEL_CLAIM' ? 'CANCELLED' : 'READY';
    return afterState === target;
  });
}

function loadBootstrap(root) {
  const path = join(root, 'governance/bootstrap.json');
  if (!existsSync(path)) return { errors: ['governance/bootstrap.json: bootstrap contract is missing'] };
  let contract;
  try {
    contract = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { errors: ['governance/bootstrap.json: bootstrap contract must be valid JSON'] };
  }
  const keys = Object.keys(contract).sort();
  const expectedKeys = [
    'base_sha',
    'bootstrap_id',
    'required_contracts',
    'schema_version',
    'work_item_id',
  ].sort();
  const errors = [];
  if (!sameArray(keys, expectedKeys)) errors.push('governance/bootstrap.json: contract must be closed');
  if (contract.schema_version !== 1 || contract.bootstrap_id !== 'g2a-coordination-bootstrap') {
    errors.push('governance/bootstrap.json: unsupported bootstrap contract');
  }
  if (!/^[a-f0-9]{40}$/u.test(contract.base_sha ?? '')) {
    errors.push('governance/bootstrap.json: base_sha must be a full Git SHA');
  }
  if (contract.work_item_id !== 'G2A') errors.push('governance/bootstrap.json: work item must be G2A');
  if (
    !Array.isArray(contract.required_contracts) ||
    !sameArray(contract.required_contracts, [
      'work/schema/work-evidence.schema.json',
      'work/schema/work-item.schema.json',
    ])
  ) {
    errors.push('governance/bootstrap.json: required contracts are not exact');
  }
  return { contract, errors };
}

function bootstrapErrors(root, base, head, changed, ledger) {
  const loaded = loadBootstrap(root);
  const errors = [...loaded.errors];
  const contract = loaded.contract;
  if (!contract) return errors;
  if (base !== contract.base_sha) errors.push('bootstrap base does not match the checked-in contract');
  if (!ancestor(root, contract.base_sha, head)) errors.push('bootstrap HEAD must descend from its known base');
  if (gitText(root, base, 'work/schema/work-item.schema.json') !== undefined) {
    errors.push('bootstrap is permanently disabled after the base contains the work-item schema');
  }
  for (const path of contract.required_contracts) {
    if (gitText(root, head, path) === undefined) errors.push(`bootstrap must introduce ${path}`);
  }
  const record = ledger.records.find((entry) => entry.item.id === contract.work_item_id);
  if (!record || record.item.state !== 'PROPOSED') {
    errors.push('bootstrap must introduce G2A in PROPOSED');
  }
  if (record?.events.length) errors.push('bootstrap G2A must not contain evidence');
  for (const entry of changed) {
    if (entry.status === 'D' || entry.status === 'T') {
      errors.push(`${entry.path}: bootstrap may not delete or change file types`);
    }
    if (record && !scopeCovers(record.item.scope.paths, entry.path)) {
      errors.push(`${entry.path}: bootstrap change is outside G2A declared scope`);
    }
  }
  errors.push(...generatedErrorsInWorktree(root, ledger));
  return errors;
}

function linearHistoryErrors(root, base, head, commits) {
  if (!commits) return [`cannot enumerate introduced commits from ${base} to ${head}`];
  if (commits.length === 0) {
    return base === head ? [] : ['introduced commit chain is empty but base and HEAD differ'];
  }
  const errors = [];
  let expectedParent = base;
  for (const commit of commits) {
    const parents = commitParents(root, commit);
    if (parents.length !== 1) {
      errors.push(`${commit}: every introduced commit must have exactly one parent; merge commits are forbidden`);
      continue;
    }
    if (parents[0] !== expectedParent) {
      errors.push(`${commit}: introduced commits must form one linear chain beginning at the declared base`);
    }
    expectedParent = commit;
  }
  if (commits.at(-1) !== head) {
    errors.push('introduced commit chain does not terminate at current HEAD');
  }
  return errors;
}

function historyValidationPlan(root, base, head, eventName) {
  if (eventName !== 'merge_group') {
    const commits = introducedCommits(root, base, head);
    const transitions = [];
    let parent = base;
    for (const commit of commits ?? []) {
      transitions.push({ parent, commit });
      parent = commit;
    }
    return {
      commits,
      transitions,
      reviewHead: head,
      platformMerges: new Set(),
      errors: linearHistoryErrors(root, base, head, commits),
    };
  }

  const errors = [];
  const queueMerges = [];
  let queueCommit = head;
  while (queueCommit !== base) {
    const parents = commitParents(root, queueCommit);
    if (parents.length !== 2) {
      errors.push(
        `${queueCommit}: merge_group history must be a first-parent chain of two-parent platform merges beginning at the declared base`,
      );
      return {
        commits: [],
        transitions: [],
        reviewHead: head,
        platformMerges: new Set(),
        errors,
      };
    }
    queueMerges.unshift({ commit: queueCommit, queueParent: parents[0], sourceHead: parents[1] });
    queueCommit = parents[0];
    if (!ancestor(root, base, queueCommit)) {
      errors.push(`${head}: merge_group first-parent chain does not descend from the declared base`);
      return {
        commits: [],
        transitions: [],
        reviewHead: head,
        platformMerges: new Set(),
        errors,
      };
    }
  }

  const commits = [];
  const transitions = [];
  const expected = new Set();
  const platformMerges = new Set(queueMerges.map(({ commit }) => commit));
  for (const { commit, queueParent, sourceHead } of queueMerges) {
    const sourceBase = mergeBase(root, queueParent, sourceHead);
    if (!sourceBase || !ancestor(root, base, sourceBase)) {
      errors.push(`${commit}: merge_group source parent has no valid base in the queue history`);
      continue;
    }
    const sourceCommits = introducedCommits(root, sourceBase, sourceHead);
    errors.push(...linearHistoryErrors(root, sourceBase, sourceHead, sourceCommits));
    let sourceParent = sourceBase;
    for (const sourceCommit of sourceCommits ?? []) {
      if (!expected.has(sourceCommit)) {
        commits.push(sourceCommit);
        transitions.push({ parent: sourceParent, commit: sourceCommit });
        expected.add(sourceCommit);
      }
      sourceParent = sourceCommit;
    }
    transitions.push({ parent: queueParent, commit });
    expected.add(commit);
  }

  const allIntroduced = introducedCommits(root, base, head);
  if (
    !allIntroduced ||
    allIntroduced.length !== expected.size ||
    allIntroduced.some((commit) => !expected.has(commit))
  ) {
    errors.push(`${head}: merge_group history contains commits outside its linear source chains and platform merges`);
  }
  return { commits, transitions, reviewHead: head, platformMerges, errors };
}

export function claimOnlyDiffErrors(root, request, itemId, requestEvent, requestSha = 'HEAD') {
  const changes = statusDiff(root, request.base_sha, requestSha);
  if (!changes) return [`${itemId}: cannot inspect claim request diff`];
  const allowed = new Set([`work/items/${itemId}.md`, eventPath(requestEvent), ...GENERATED_PATHS]);
  const errors = [];
  for (const entry of changes) {
    if (!allowed.has(entry.path)) errors.push(`${entry.path}: claim request diff is not claim-only`);
    if (entry.path === eventPath(requestEvent) && entry.status !== 'A') {
      errors.push(`${entry.path}: claim request evidence must be newly added`);
    }
    if (['D', 'T'].includes(entry.status)) {
      errors.push(`${entry.path}: claim request may not delete or change file types`);
    }
  }
  if (!changes.some((entry) => entry.path === eventPath(requestEvent) && entry.status === 'A')) {
    errors.push(`${itemId}: claim request SHA does not add its exact event file`);
  }
  const requestLedger = snapshotLedger(root, requestSha);
  errors.push(
    ...generatedErrorsAt(
      root,
      requestSha,
      changes.map((entry) => entry.path),
      requestLedger,
    ),
  );
  return errors;
}

export function verifyResumeWorktree(root, claim, candidate) {
  const errors = [];
  let actualRoot;
  try {
    actualRoot = realpathSync(gitLine(root, ['rev-parse', '--show-toplevel']));
  } catch {
    return ['resume root is not a Git worktree'];
  }
  if (actualRoot !== realpathSync(resolve(root)) || resolve(candidate.root ?? '') !== actualRoot) {
    errors.push('resume root does not exactly match the current Git worktree');
  }
  const listed = gitLine(root, ['worktree', 'list', '--porcelain']);
  const registeredRoots = (listed ?? '')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .filter((path) => existsSync(path))
    .map((path) => realpathSync(path));
  if (!registeredRoots.includes(actualRoot)) {
    errors.push('resume root is not a registered Git worktree');
  }
  const actualBinding = worktreeBinding(actualRoot);
  if (claim.worktree !== actualBinding || candidate.worktree !== actualBinding) {
    errors.push('resume worktree binding does not match the registered realpath');
  }
  if (gitLine(root, ['branch', '--show-current']) !== claim.branch) {
    errors.push('resume branch does not match claim');
  }
  const head = gitLine(root, ['rev-parse', 'HEAD']);
  if (!head || !commitExists(root, claim.request_sha) || !ancestor(root, claim.request_sha, head)) {
    errors.push('resume HEAD does not descend from the merged claim request');
  }
  if (
    claim.claim_id !== candidate.claim_id ||
    !sameIdentity(claim, candidate) ||
    claim.branch !== candidate.branch ||
    claim.worktree !== candidate.worktree ||
    !sameArray(claim.packages, candidate.packages) ||
    !sameArray(claim.paths, candidate.paths) ||
    !sameArray(claim.exclusive_resources, candidate.exclusive_resources)
  ) {
    errors.push(
      'resume claim ID, branch, owner, actor, worktree, packages, paths, or resources differ',
    );
  }
  return errors;
}

export function authenticatedEventActorErrors(event, environment = process.env) {
  if (environment.GITHUB_EVENT_NAME !== 'pull_request') return [];
  if (!environment.GITHUB_ACTOR) {
    return [`${event.work_item_id}: authenticated GITHUB_ACTOR is required for new evidence`];
  }
  if (event.actor.github_actor !== environment.GITHUB_ACTOR) {
    return [
      `${event.work_item_id}: new ${event.type} actor ${event.actor.github_actor} does not match authenticated PR actor ${environment.GITHUB_ACTOR}`,
    ];
  }
  return [];
}

function currentEventMaps(ledger) {
  const byPath = new Map();
  for (const record of ledger.records) {
    for (const event of record.events) byPath.set(eventPath(event), { record, event });
  }
  return byPath;
}

function validateActivationGit(root, record, event, base, head, changedPaths, environment) {
  const errors = [];
  const requestEntry = record.replay.requests.get(event.claim.claim_id);
  const requestEvent = requestEntry?.event;
  if (!requestEntry || !requestEvent || !commitExists(root, event.claim.request_sha)) {
    return [`${record.item.id}: activation requires an existing merged request commit`];
  }
  if (
    !ancestor(root, requestEntry.request.base_sha, event.claim.request_sha) ||
    !exactEventAt(root, event.claim.request_sha, requestEvent)
  ) {
    errors.push(
      `${record.item.id}: request SHA must descend from its declared base and contain the exact canonical request event`,
    );
  }
  if (!ancestor(root, event.claim.request_sha, head)) {
    errors.push(`${record.item.id}: request SHA is not in current HEAD ancestry`);
  }
  const activationCommit = commitAddingPath(root, eventPath(event));
  if (
    !activationCommit ||
    activationCommit === event.claim.request_sha ||
    !ancestor(root, event.claim.request_sha, activationCommit)
  ) {
    errors.push(`${record.item.id}: activation must be added by a later commit than its request`);
  }
  errors.push(
    ...claimOnlyDiffErrors(
      root,
      requestEntry.request,
      record.item.id,
      requestEvent,
      event.claim.request_sha,
    ),
  );

  const activationIsCurrent = changedPaths.has(eventPath(event));
  if (activationIsCurrent && base && !ancestor(root, event.claim.request_sha, base)) {
    errors.push(`${record.item.id}: current activation base must already contain the request SHA`);
  }
  if (
    environment.GITHUB_EVENT_NAME === 'pull_request' &&
    activationIsCurrent &&
    environment.GITHUB_HEAD_REF &&
    environment.GITHUB_HEAD_REF !== event.claim.branch
  ) {
    errors.push(`${record.item.id}: current activation branch differs from CI head ref`);
  }
  return errors;
}

function validateCurrentActivationDiff(root, ledger, base, head, changed, eventMap) {
  const errors = [];
  const currentActivations = changed
    .filter((entry) => entry.status === 'A')
    .map((entry) => eventMap.get(entry.path))
    .filter((binding) => binding?.event.type === 'CLAIM' || binding?.event.type === 'RECLAIM');
  for (const { record, event } of currentActivations) {
    const itemPath = record.parsedItem.path;
    const allowed = new Set([itemPath, eventPath(event), ...GENERATED_PATHS]);
    for (const entry of changed) {
      const binding = eventMap.get(entry.path);
      if (binding?.record === record && binding.event.type === 'WORK_ITEM_AMENDMENT') {
        allowed.add(entry.path);
      }
      if (!allowed.has(entry.path)) {
        errors.push(`${entry.path}: current ${event.type} activation diff is not activation-only`);
      }
    }
    const beforeText = gitText(root, base, itemPath);
    const afterText = gitText(root, head, itemPath);
    if (beforeText === undefined || afterText === undefined) {
      errors.push(`${record.item.id}: activation must update an existing canonical item`);
      continue;
    }
    try {
      const before = parseWorkItemMarkdown(beforeText, `${base}:${itemPath}`);
      const after = parseWorkItemMarkdown(afterText, `${head}:${itemPath}`);
      if (before.metadata.state !== 'READY' || after.metadata.state !== 'CLAIMED') {
        errors.push(`${record.item.id}: activation item state must change exactly READY to CLAIMED`);
      }
      if (before.body !== after.body) {
        errors.push(`${record.item.id}: activation-only diff cannot change work-item prose`);
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  return errors;
}

function validateCurrentRequests(root, ledger, changedPaths, base, head, environment) {
  const errors = [];
  for (const record of ledger.records) {
    for (const { request, event } of record.replay.requests.values()) {
      if (!changedPaths.has(eventPath(event))) continue;
      if (request.base_sha !== base || !ancestor(root, request.base_sha, head)) {
        errors.push(`${record.item.id}: current claim request must declare the current base`);
      }
      if (!exactEventAt(root, head, event)) {
        errors.push(`${record.item.id}: current HEAD must contain the exact request event`);
      }
      errors.push(...claimOnlyDiffErrors(root, request, record.item.id, event, head));
      if (
        environment.GITHUB_EVENT_NAME === 'pull_request' &&
        environment.GITHUB_HEAD_REF &&
        environment.GITHUB_HEAD_REF !== request.branch
      ) {
        errors.push(`${record.item.id}: current request branch differs from CI head ref`);
      }
      if (
        environment.GITHUB_EVENT_NAME === 'pull_request' &&
        environment.GITHUB_ACTOR &&
        environment.GITHUB_ACTOR !== request.github_actor
      ) {
        errors.push(`${record.item.id}: current request actor differs from CI actor`);
      }
    }
  }
  return errors;
}

function operationRequestOnlyDiffErrors(root, record, event, parent, commit, changed) {
  const errors = [];
  const allowed = new Set([eventPath(event), ...GENERATED_PATHS]);
  for (const entry of changed) {
    if (!allowed.has(entry.path)) {
      errors.push(`${entry.path}: OPERATION_REQUEST diff is not request-only`);
    }
    if (['D', 'T'].includes(entry.status)) {
      errors.push(`${entry.path}: operation request may not delete or change file types`);
    }
  }
  if (!changed.some((entry) => entry.status === 'A' && entry.path === eventPath(event))) {
    errors.push(`${record.item.id}: operation request commit must add its exact event file`);
  }
  if (!exactEventAt(root, commit, event)) {
    errors.push(`${record.item.id}: operation request commit must contain the exact canonical request event`);
  }
  const ledgerAtCommit = snapshotLedger(root, commit);
  errors.push(
    ...generatedErrorsAt(
      root,
      commit,
      changed.map((entry) => entry.path),
      ledgerAtCommit,
    ),
  );
  if (!ancestor(root, parent, commit)) {
    errors.push(`${record.item.id}: operation request commit must descend from its parent`);
  }
  return errors;
}

function reviewedOperationDiffErrors(record, event, changed) {
  const allowed = new Set([record.parsedItem.path, eventPath(event), ...GENERATED_PATHS]);
  const errors = [];
  for (const entry of changed) {
    if (!allowed.has(entry.path)) {
      errors.push(`${entry.path}: reviewed ${event.type} diff is not operation-only`);
    }
    if (['D', 'T'].includes(entry.status)) {
      errors.push(`${entry.path}: reviewed operation may not delete or change file types`);
    }
  }
  return errors;
}

function validateOperationGit(root, ledger, base, head, changed, eventMap) {
  const errors = [];
  const added = new Set(
    changed.filter((entry) => entry.status === 'A').map((entry) => entry.path),
  );
  for (const record of ledger.records) {
    for (const event of record.events.filter((entry) => REVIEWED_OPERATIONS.has(entry.type))) {
      const requestEntry = record.replay.operationRequests.get(event.operation_id);
      const requestEvent = requestEntry?.event;
      const requestSha = event.operation_request_sha;
      const reviewCommit = commitAddingPath(root, eventPath(event));
      const requestCommit = requestEvent ? commitAddingPath(root, eventPath(requestEvent)) : undefined;
      if (
        !requestEvent ||
        !commitExists(root, requestSha) ||
        requestCommit !== requestSha ||
        !exactEventAt(root, requestSha, requestEvent)
      ) {
        errors.push(`${record.item.id}: reviewed operation must bind the exact commit that added its canonical operation request`);
        continue;
      }
      if (
        !reviewCommit ||
        reviewCommit === requestSha ||
        !ancestor(root, requestSha, reviewCommit)
      ) {
        errors.push(`${record.item.id}: reviewed operation must be committed strictly after its operation request`);
      }
      const requestParents = commitParents(root, requestSha);
      if (requestParents.length !== 1) {
        errors.push(`${record.item.id}: operation request commit must have exactly one parent`);
      } else {
        const requestDiff = statusDiff(root, requestParents[0], requestSha);
        if (!requestDiff) {
          errors.push(`${record.item.id}: cannot inspect operation request commit diff`);
        } else {
          errors.push(
            ...operationRequestOnlyDiffErrors(
              root,
              record,
              requestEvent,
              requestParents[0],
              requestSha,
              requestDiff,
            ),
          );
        }
      }
      if (added.has(eventPath(event))) {
        if (!ancestor(root, requestSha, base)) {
          errors.push(`${record.item.id}: reviewed operation base must already contain its operation request commit`);
        }
        errors.push(...reviewedOperationDiffErrors(record, event, changed));
      }
    }
  }

  for (const binding of [...eventMap.values()].filter(
    ({ event }) => event.type === 'OPERATION_REQUEST' && added.has(eventPath(event)),
  )) {
    errors.push(...operationRequestOnlyDiffErrors(root, binding.record, binding.event, base, head, changed));
  }
  return errors;
}

function validateEvidenceChanges(root, head, changed, eventMap, environment) {
  const errors = [];
  for (const entry of changed.filter((change) => change.path.startsWith(EVIDENCE_PREFIX))) {
    if (entry.status !== 'A') {
      errors.push(`append-only evidence violation: ${entry.status}\t${entry.path}`);
      continue;
    }
    const binding = eventMap.get(entry.path);
    if (!binding) {
      errors.push(`${entry.path}: added evidence does not bind one exact canonical event`);
      continue;
    }
    if (!exactEventAt(root, head, binding.event)) {
      errors.push(`${entry.path}: current HEAD does not contain the exact canonical event blob`);
    }
    errors.push(...authenticatedEventActorErrors(binding.event, environment));
  }
  return errors;
}

function baseItemPaths(root, base) {
  return (listTree(root, base, 'work/items') ?? []).filter((path) => path.endsWith('.md'));
}

function validateWorkItems(root, base, changed, ledger, baseLedger, eventMap) {
  const errors = [];
  const changedByPath = new Map(changed.map((entry) => [entry.path, entry]));
  const addedEventPaths = new Set(
    changed
      .filter((entry) => entry.status === 'A' && entry.path.startsWith(EVIDENCE_PREFIX))
      .map((entry) => entry.path),
  );

  for (const path of baseItemPaths(root, base)) {
    if (!ledger.records.some((record) => record.parsedItem.path === path)) {
      errors.push(`${path}: canonical work items and IDs are immutable`);
    }
  }

  for (const record of ledger.records) {
    const path = record.parsedItem.path;
    const change = changedByPath.get(path);
    if (!change) continue;
    if (change.status === 'D' || change.status === 'T') {
      errors.push(`${path}: canonical work item cannot be deleted or type-changed`);
      continue;
    }
    const baseText = gitText(root, base, path);
    if (baseText === undefined) {
      if (record.item.state !== 'PROPOSED' && record.events.length === 0) {
        errors.push(`${path}: new items begin PROPOSED unless complete evidence replays another state`);
      }
      continue;
    }

    let before;
    try {
      before = parseWorkItemMarkdown(baseText, `${base}:${path}`);
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    if (before.metadata.id !== record.item.id) {
      errors.push(`${path}: work item ID is immutable`);
    }
    if (before.metadataSha256 !== record.parsedItem.metadataSha256) {
      const stateOnlyChange =
        JSON.stringify(metadataWithoutState(before.metadata)) ===
          JSON.stringify(metadataWithoutState(record.item)) &&
        stateChangeExplained(
          before.metadata.state,
          record.item.state,
          record.events,
          addedEventPaths,
        );
      const amendments = record.events
        .filter((event) => event.type === 'WORK_ITEM_AMENDMENT' && addedEventPaths.has(eventPath(event)))
        .sort((left, right) => left.sequence - right.sequence);
      let expectedBefore = before.metadataSha256;
      for (const amendment of amendments) {
        if (amendment.before_metadata_sha256 !== expectedBefore) {
          errors.push(`${path}: amendment chain does not bind the preceding metadata hash`);
        }
        expectedBefore = amendment.after_metadata_sha256;
        const baseOwner = baseLedger?.records.find(
          (entry) => entry.item.id === record.item.id,
        )?.replay.claim;
        const baseOwnerWasReleased = record.events.some(
          (event) =>
            addedEventPaths.has(eventPath(event)) &&
            CLOSURES.has(event.type) &&
            event.sequence < amendment.sequence,
        );
        const owners = [baseOwnerWasReleased ? undefined : baseOwner, record.replay.claim].filter(
          Boolean,
        );
        if (owners.some((owner) => identityConflicts(owner, amendment.review))) {
          errors.push(`${path}: amendment reviewer must differ from the current owner`);
        }
      }
      if (
        !stateOnlyChange &&
        (amendments.length === 0 || expectedBefore !== record.parsedItem.metadataSha256)
      ) {
        errors.push(`${path}: metadata changes require a newly added exact WORK_ITEM_AMENDMENT chain`);
      }

      const baseRecord = baseLedger?.records.find((entry) => entry.item.id === record.item.id);
      if (
        baseRecord &&
        ['CLAIMED', 'IN_REVIEW'].includes(baseRecord.item.state) &&
        scopeExpanded(before.metadata.scope, record.item.scope)
      ) {
        const firstAmendment = amendments[0];
        const releasedFirst = record.events.some(
          (event) =>
            addedEventPaths.has(eventPath(event)) &&
            CLOSURES.has(event.type) &&
            firstAmendment &&
            event.sequence < firstAmendment.sequence,
        );
        if (!releasedFirst) {
          errors.push(`${path}: active scope cannot expand before a typed release`);
        }
      }
    }

    if (before.body !== record.parsedItem.body) {
      const owners = ledger.records.filter(
        (candidate) =>
          candidate.replay.claim &&
          ['CLAIMED', 'IN_REVIEW'].includes(candidate.item.state) &&
          scopeCovers(candidate.replay.claim.paths, path),
      );
      if (owners.length !== 1) {
        errors.push(`${path}: item prose may change only under exactly one current active claim`);
      }
    }
  }
  return errors;
}

function implementationOwners(ledger, path) {
  return ledger.records.filter(
    (record) =>
      record.replay.claim &&
      ['CLAIMED', 'IN_REVIEW'].includes(record.item.state) &&
      scopeCovers(record.replay.claim.paths, path),
  );
}

function activationForEvent(record, reviewEvent) {
  let activation;
  for (const event of record.events) {
    if (event.sequence >= reviewEvent.sequence) break;
    if (event.type === 'CLAIM' || event.type === 'RECLAIM') activation = event;
    if (CLOSURES.has(event.type)) activation = undefined;
  }
  return activation;
}

function claimedImplementationChanges(root, older, newer, record, claim, platformMerges) {
  const errors = [];
  const commits = introducedCommits(root, older, newer);
  if (!commits) return [`${record.item.id}: cannot inspect reviewed implementation history`];
  const operationPaths = new Set([
    record.parsedItem.path,
    ...record.events.map(eventPath),
    ...GENERATED_PATHS,
  ]);
  for (const commit of commits) {
    const parents = commitParents(root, commit);
    const platformMerge = parents.length === 2 && platformMerges.has(commit);
    if (parents.length !== 1 && !platformMerge) {
      errors.push(`${record.item.id}: reviewed implementation history contains a merge commit ${commit}`);
      continue;
    }
    const changed = statusDiff(root, parents[0], commit);
    if (!changed) {
      errors.push(`${record.item.id}: cannot inspect reviewed implementation commit ${commit}`);
      continue;
    }
    for (const entry of changed) {
      if (!operationPaths.has(entry.path) && scopeCovers(claim.paths, entry.path)) {
        errors.push(
          `${record.item.id}: claimed implementation changed after reviewed SHA at ${entry.path} in ${commit}`,
        );
      }
    }
  }
  return errors;
}

function reviewShaErrors(root, record, head, platformMerges = new Set()) {
  const errors = [];
  const reviews = record.events.filter(
    (event) => event.type === 'REVIEW' || event.type === 'PROVENANCE_REVIEW',
  );
  for (const event of reviews) {
    const activation = activationForEvent(record, event);
    const activationCommit = activation ? commitAddingPath(root, eventPath(activation)) : undefined;
    const reviewCommit = commitAddingPath(root, eventPath(event));
    if (
      !activation ||
      !activationCommit ||
      !commitExists(root, event.reviewed_sha) ||
      event.reviewed_sha === activationCommit ||
      !ancestor(root, activationCommit, event.reviewed_sha)
    ) {
      errors.push(`${record.item.id}: ${event.type} reviewed SHA must strictly descend from the active claim activation`);
      continue;
    }
    if (
      !reviewCommit ||
      event.reviewed_sha === reviewCommit ||
      !ancestor(root, event.reviewed_sha, reviewCommit)
    ) {
      errors.push(`${record.item.id}: ${event.type} reviewed SHA must be a strict ancestor of its review event commit`);
      continue;
    }
    errors.push(
      ...claimedImplementationChanges(
        root,
        event.reviewed_sha,
        reviewCommit,
        record,
        activation.claim,
        platformMerges,
      ),
    );
    const boundaryEvent = record.events.find(
      (candidate) =>
        candidate.sequence > event.sequence &&
        (CLOSURES.has(candidate.type) ||
          (candidate.type === 'STATE_TRANSITION' && candidate.to_state === 'DONE')),
    );
    const boundaryCommit = boundaryEvent ? commitAddingPath(root, eventPath(boundaryEvent)) : head;
    if (boundaryCommit && ancestor(root, reviewCommit, boundaryCommit)) {
      errors.push(
        ...claimedImplementationChanges(
          root,
          reviewCommit,
          boundaryCommit,
          record,
          activation.claim,
          platformMerges,
        ),
      );
    }
  }
  return errors;
}

function transitionOperationPaths(root, parent, commit, changed) {
  const metadataItemPaths = changed
    .filter((entry) => entry.path.startsWith('work/items/') && entry.path.endsWith('.md'))
    .filter((entry) => {
      const before = gitText(root, parent, entry.path);
      const after = gitText(root, commit, entry.path);
      if (before === undefined || after === undefined) return true;
      try {
        return parseWorkItemMarkdown(before).body === parseWorkItemMarkdown(after).body;
      } catch {
        return true;
      }
    })
    .map((entry) => entry.path);
  return new Set([
    ...changed
      .filter((entry) => entry.path.startsWith(EVIDENCE_PREFIX) && entry.status === 'A')
      .map((entry) => entry.path),
    ...metadataItemPaths,
    ...changed.filter((entry) => GENERATED_PATHS.has(entry.path)).map((entry) => entry.path),
  ]);
}

function terminalImmutabilityErrors(parentLedger, changed) {
  const errors = [];
  if (!parentLedger) return errors;
  for (const record of parentLedger.records.filter((entry) =>
    ['DONE', 'CANCELLED'].includes(entry.item.state),
  )) {
    const evidencePrefix = `work/evidence/${record.item.id}/`;
    for (const entry of changed) {
      if (entry.path === record.parsedItem.path || entry.path.startsWith(evidencePrefix)) {
        errors.push(`${entry.path}: terminal work item and evidence records are immutable`);
      }
    }
  }
  return errors;
}

function validateIntroducedTransition(root, parent, commit, environment) {
  const errors = [];
  const changed = statusDiff(root, parent, commit);
  if (!changed) return [`${commit}: cannot inspect parent-to-commit transition`];
  const ledger = snapshotLedger(root, commit);
  const parentLedger = snapshotLedger(root, parent);
  if (!ledger) return [`${commit}: cannot reconstruct canonical ledger`];
  errors.push(...ledger.errors.map((error) => `${commit}: ${error}`));
  const eventMap = currentEventMaps(ledger);
  const changedPaths = new Set(changed.map((entry) => entry.path));
  errors.push(...validateEvidenceChanges(root, commit, changed, eventMap, environment));
  errors.push(...validateCurrentRequests(root, ledger, changedPaths, parent, commit, environment));
  errors.push(...validateCurrentActivationDiff(root, ledger, parent, commit, changed, eventMap));
  errors.push(...validateOperationGit(root, ledger, parent, commit, changed, eventMap));
  errors.push(...validateWorkItems(root, parent, changed, ledger, parentLedger, eventMap));
  errors.push(...terminalImmutabilityErrors(parentLedger, changed));
  errors.push(
    ...generatedErrorsAt(
      root,
      commit,
      changed.map((entry) => entry.path),
      ledger,
    ),
  );

  for (const binding of [...eventMap.values()].filter(
    ({ event }) =>
      (event.type === 'CLAIM' || event.type === 'RECLAIM') &&
      changedPaths.has(eventPath(event)),
  )) {
    errors.push(
      ...validateActivationGit(
        root,
        binding.record,
        binding.event,
        parent,
        commit,
        changedPaths,
        environment,
      ),
    );
  }

  const operationPaths = transitionOperationPaths(root, parent, commit, changed);
  for (const entry of changed) {
    if (operationPaths.has(entry.path)) continue;
    const owners = implementationOwners(parentLedger ?? { records: [] }, entry.path);
    if (owners.length !== 1) {
      errors.push(`${entry.path}: changed implementation path requires exactly one active claim in the parent ledger`);
      continue;
    }
    const claim = owners[0].replay.claim;
    const activationEvent = owners[0].events.find(
      (event) =>
        (event.type === 'CLAIM' || event.type === 'RECLAIM') &&
        event.claim.claim_id === claim.claim_id,
    );
    const activationCommit = activationEvent
      ? commitAddingPath(root, eventPath(activationEvent))
      : undefined;
    if (
      !activationCommit ||
      !environment.GOVERNANCE_BASE_SHA ||
      !ancestor(root, activationCommit, environment.GOVERNANCE_BASE_SHA)
    ) {
      errors.push(`${entry.path}: implementation base must already contain the active claim activation`);
    }
    if (
      environment.GITHUB_EVENT_NAME === 'pull_request' &&
      environment.GITHUB_HEAD_REF &&
      environment.GITHUB_HEAD_REF !== claim.branch
    ) {
      errors.push(`${entry.path}: current claimed change branch differs from CI head ref`);
    }
    if (
      environment.GITHUB_EVENT_NAME === 'pull_request' &&
      environment.GITHUB_ACTOR &&
      environment.GITHUB_ACTOR !== claim.github_actor
    ) {
      errors.push(`${entry.path}: current claimed change actor differs from CI actor`);
    }
  }
  return errors;
}

function doneShaErrors(root, record, head) {
  const errors = [];
  const acceptance = record.replay.acceptance;
  const acceptanceEvent = record.replay.acceptanceEvent;
  const terminalEvent = record.replay.terminalEvent;
  const completedClaim = record.replay.completedClaim;
  const activationEvent = record.events.find(
    (event) =>
      (event.type === 'CLAIM' || event.type === 'RECLAIM') &&
      event.claim.claim_id === completedClaim?.claim_id,
  );
  const activationCommit = activationEvent
    ? commitAddingPath(root, eventPath(activationEvent))
    : undefined;
  const acceptanceCommit = acceptanceEvent
    ? commitAddingPath(root, eventPath(acceptanceEvent))
    : undefined;
  const terminalCommit = terminalEvent ? commitAddingPath(root, eventPath(terminalEvent)) : undefined;
  if (
    !acceptance ||
    !commitExists(root, acceptance.merged_sha) ||
    !ancestor(root, acceptance.merged_sha, head)
  ) {
    errors.push(`${record.item.id}: DONE accepted SHA must be an existing current HEAD ancestor`);
    return errors;
  }
  if (!activationCommit || !ancestor(root, activationCommit, acceptance.merged_sha)) {
    errors.push(`${record.item.id}: DONE accepted SHA must descend from the claim activation commit`);
  }
  if (!acceptanceCommit || !ancestor(root, acceptance.merged_sha, acceptanceCommit)) {
    errors.push(`${record.item.id}: DONE accepted SHA must be an ancestor of its acceptance event commit`);
  }
  if (!terminalCommit || !ancestor(root, acceptanceCommit ?? acceptance.merged_sha, terminalCommit)) {
    errors.push(`${record.item.id}: DONE terminal event must descend from canonical acceptance`);
    return errors;
  }
  const range = statusDiff(root, acceptance.merged_sha, terminalCommit);
  if (!range) {
    errors.push(`${record.item.id}: cannot inspect accepted-to-terminal Git range`);
    return errors;
  }
  const operationPaths = new Set([
    record.parsedItem.path,
    ...record.events.map(eventPath),
    ...GENERATED_PATHS,
  ]);
  for (const entry of range) {
    if (
      !operationPaths.has(entry.path) &&
      completedClaim &&
      scopeCovers(completedClaim.paths, entry.path)
    ) {
      errors.push(
        `${record.item.id}: claimed implementation changed after accepted SHA and before terminal DONE at ${entry.path}`,
      );
    }
  }
  return errors;
}

export function verifyGitContext(root, ledger, environment = process.env) {
  const errors = [];
  const eventName = environment.GITHUB_EVENT_NAME;
  const base = environment.GOVERNANCE_BASE_SHA;
  const head = gitLine(root, ['rev-parse', 'HEAD']);
  if (!head) return ['cannot resolve current HEAD'];
  if (!base) {
    return [
      eventName === 'pull_request' || eventName === 'merge_group'
        ? 'GOVERNANCE_BASE_SHA is required in pull_request and merge_group contexts'
        : 'GOVERNANCE_BASE_SHA is required for full Git-context validation',
    ];
  }
  if (/^0{40}$/u.test(base)) {
    return [
      'repository-creation push has no comparable base; full Git-context validation fails closed',
    ];
  }
  if (!commitExists(root, base)) return [`declared governance base ${base} is not an available commit`];
  if (!ancestor(root, base, head)) return [`declared governance base ${base} is stale or not a HEAD ancestor`];
  const history = historyValidationPlan(root, base, head, eventName);
  const commits = history.commits;
  errors.push(...history.errors);
  const changed = statusDiff(root, base, head);
  if (!changed) return [`cannot inspect current name-status diff from ${base}`];
  const changedPaths = new Set(changed.map((entry) => entry.path));

  const baseHasSchema = gitText(root, base, 'work/schema/work-item.schema.json') !== undefined;
  const headHasSchema = gitText(root, head, 'work/schema/work-item.schema.json') !== undefined;
  if (!baseHasSchema && headHasSchema) {
    if (commits?.length !== 1) {
      errors.push('bootstrap requires exactly one introduced commit');
    }
    errors.push(...bootstrapErrors(root, base, head, changed, ledger));
    return errors;
  }
  if (!baseHasSchema) {
    return ['governance base lacks the work-item schema and this is not a valid bootstrap'];
  }

  for (const { parent, commit } of history.transitions) {
    errors.push(...validateIntroducedTransition(root, parent, commit, environment));
  }

  const eventMap = currentEventMaps(ledger);
  errors.push(...validateEvidenceChanges(root, head, changed, eventMap, environment));
  errors.push(...validateCurrentRequests(root, ledger, changedPaths, base, head, environment));
  errors.push(...validateCurrentActivationDiff(root, ledger, base, head, changed, eventMap));
  errors.push(...validateOperationGit(root, ledger, base, head, changed, eventMap));

  for (const record of ledger.records) {
    for (const event of record.events.filter((entry) => entry.type === 'CLAIM' || entry.type === 'RECLAIM')) {
      errors.push(
        ...validateActivationGit(root, record, event, base, head, changedPaths, environment),
      );
    }
  }

  const baseLedger = snapshotLedger(root, base);
  errors.push(...validateWorkItems(root, base, changed, ledger, baseLedger, eventMap));
  errors.push(...generatedErrorsInWorktree(root, ledger));

  for (const record of ledger.records.filter((entry) => entry.item.state === 'DONE')) {
    errors.push(...doneShaErrors(root, record, head));
  }
  for (const record of ledger.records) {
    errors.push(...reviewShaErrors(root, record, history.reviewHead, history.platformMerges));
  }
  return errors;
}
