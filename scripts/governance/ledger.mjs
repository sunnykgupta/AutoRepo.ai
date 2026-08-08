import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import YAML from 'yaml';

export const STATES = Object.freeze([
  'PROPOSED',
  'BLOCKED',
  'READY',
  'CLAIMED',
  'IN_REVIEW',
  'DONE',
  'CANCELLED',
]);

export const EVENT_TYPES = Object.freeze([
  'STATE_TRANSITION',
  'CLAIM_REQUEST',
  'CLAIM',
  'OPERATION_REQUEST',
  'RENEW',
  'RELEASE',
  'HANDOFF',
  'PAUSE',
  'CANCEL_CLAIM',
  'RECLAIM',
  'REVIEW',
  'PROVENANCE_ATTESTATION',
  'PROVENANCE_REVIEW',
  'ACCEPTANCE',
  'WORK_ITEM_AMENDMENT',
]);

export const LEGAL_TRANSITIONS = Object.freeze({
  PROPOSED: new Set(['BLOCKED', 'READY', 'CANCELLED']),
  BLOCKED: new Set(['PROPOSED', 'READY', 'CANCELLED']),
  READY: new Set(['BLOCKED', 'CANCELLED']),
  CLAIMED: new Set(['IN_REVIEW']),
  IN_REVIEW: new Set(['DONE']),
  DONE: new Set(),
  CANCELLED: new Set(),
});

const OWNED_STATES = new Set(['CLAIMED', 'IN_REVIEW']);
const CLOSURE_EVENTS = new Set(['RELEASE', 'HANDOFF', 'PAUSE', 'CANCEL_CLAIM']);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!object(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function canonicalMetadata(metadata) {
  return `${JSON.stringify(canonicalize(metadata))}\n`;
}

export function metadataSha256(metadata) {
  return createHash('sha256').update(canonicalMetadata(metadata)).digest('hex');
}

export function parseWorkItemMarkdown(text, label = 'work item') {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(text);
  if (!match) throw new Error(`${label}: Markdown front matter is required`);
  const document = YAML.parseDocument(match[1], { uniqueKeys: true, prettyErrors: false });
  const metadata = document.toJS();
  if (document.errors.length > 0 || !object(metadata)) {
    throw new Error(`${label}: unique-key YAML object front matter is required`);
  }
  return {
    metadata,
    body: text.slice(match[0].length),
    metadataSha256: metadataSha256(metadata),
  };
}

function ajv2020() {
  const instance = new Ajv2020({ allErrors: true, strict: false });
  instance.addFormat('date-time', {
    type: 'string',
    validate(value) {
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value) && !Number.isNaN(Date.parse(value));
    },
  });
  return instance;
}

function entries(path) {
  return existsSync(path)
    ? readdirSync(path, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
    : [];
}

function loadPrincipals(root) {
  const path = join(root, 'governance/owners.yaml');
  const document = YAML.parseDocument(readFileSync(path, 'utf8'), {
    uniqueKeys: true,
    prettyErrors: false,
  });
  if (document.errors.length > 0) throw new Error(`${path}: owners YAML must have unique keys`);
  const owners = document.toJS();
  const principals = new Map(
    Object.values(owners?.principals ?? {}).map((principal) => [principal.principal_id, principal]),
  );
  principals.activeMaintainers = new Set(
    (owners?.authorities ?? [])
      .filter((authority) => authority.id === 'O1' && authority.status === 'active')
      .map((authority) => authority.holder?.principal_id)
      .filter(Boolean),
  );
  return principals;
}

function same(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function identity(actor) {
  return actor && { principal: actor.principal, github_actor: actor.github_actor };
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

function claimScope(claim) {
  return {
    packages: claim?.packages,
    paths: claim?.paths,
    exclusive_resources: claim?.exclusive_resources,
  };
}

function requestPayload(claim) {
  if (!claim) return claim;
  const { request_sha: ignored, ...request } = claim;
  return request;
}

function reviewedOperationProposal(event) {
  if (event.type === 'RENEW') {
    return { target_claim_id: event.renewal?.claim_id, renewal: event.renewal };
  }
  if (CLOSURE_EVENTS.has(event.type)) {
    return { target_claim_id: event.target_claim_id, from_state: event.from_state };
  }
  if (event.type === 'RECLAIM') {
    return { target_request_id: event.claim?.claim_id, claim: event.claim };
  }
  if (event.type === 'WORK_ITEM_AMENDMENT') {
    return {
      before_metadata_sha256: event.before_metadata_sha256,
      after_metadata_sha256: event.after_metadata_sha256,
    };
  }
  return undefined;
}

function validateActor(actor, principals, errors, itemId, label) {
  if (!actor) {
    errors.push(`${itemId}: ${label} is missing`);
    return false;
  }
  if (actor.kind === 'agent') return true;
  const principal = principals.get(actor.principal);
  if (
    !principal ||
    principal.active !== true ||
    principal.type !== 'human' ||
    principal.github !== actor.github_actor
  ) {
    errors.push(`${itemId}: ${label} must bind an active registered governance human`);
    return false;
  }
  return true;
}

function validateReview(event, owner, operationActor, principals, errors, itemId, label) {
  validateActor(event.review, principals, errors, itemId, `${label} reviewer`);
  if (!sameIdentity(event.actor, event.review)) {
    errors.push(`${itemId}: ${label} event actor must exactly bind the nested reviewer`);
  }
  if (identityConflicts(event.review, owner) || identityConflicts(event.review, operationActor)) {
    errors.push(`${itemId}: ${label} reviewer must be independent of owner and operation actor`);
  }
}

function requiredChecksPass(item, acceptance) {
  if (!acceptance || acceptance.tested_sha !== acceptance.merged_sha) return false;
  const checks = new Map(acceptance.checks.map((check) => [check.name, check.status]));
  return item.acceptance.required_checks.every((name) => checks.get(name) === 'passed');
}

export function validScopePath(path) {
  return (
    /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?:[-A-Za-z0-9_.]+\/)*[-A-Za-z0-9_.]+(?:\/\*\*)?$/u.test(path) &&
    (!path.includes('*') || path.endsWith('/**'))
  );
}

export function pathsOverlap(left, right) {
  const leftRecursive = left.endsWith('/**');
  const rightRecursive = right.endsWith('/**');
  const leftParts = (leftRecursive ? left.slice(0, -3) : left).split('/');
  const rightParts = (rightRecursive ? right.slice(0, -3) : right).split('/');
  if (leftRecursive) return leftParts.every((part, index) => rightParts[index] === part);
  if (rightRecursive) return rightParts.every((part, index) => leftParts[index] === part);
  return left === right;
}

export function scopesOverlap(left, right) {
  const stringArray = (value) =>
    Array.isArray(value) && value.every((entry) => typeof entry === 'string');
  if (
    !object(left) ||
    !object(right) ||
    !stringArray(left.packages) ||
    !stringArray(right.packages) ||
    !stringArray(left.paths) ||
    !stringArray(right.paths) ||
    !stringArray(left.exclusive_resources) ||
    !stringArray(right.exclusive_resources)
  ) {
    return false;
  }
  return (
    left.packages.some((entry) => right.packages.includes(entry)) ||
    left.exclusive_resources.some((entry) => right.exclusive_resources.includes(entry)) ||
    left.paths.some((entry) => right.paths.some((other) => pathsOverlap(entry, other)))
  );
}

export function legalTransition(from, to) {
  return LEGAL_TRANSITIONS[from]?.has(to) === true;
}

export function canResume(claim, candidate) {
  return (
    sameIdentity(claim, candidate) &&
    claim.claim_id === candidate.claim_id &&
    claim.branch === candidate.branch &&
    claim.worktree === candidate.worktree &&
    same(claimScope(claim), claimScope(candidate))
  );
}

export function replayEvidence(item, events, now = new Date(), principals = new Map()) {
  const errors = [];
  const requests = new Map();
  const consumedRequests = new Set();
  const operationRequests = new Map();
  const consumedOperationRequests = new Set();
  const eventIds = new Set();
  const amendments = [];
  const claimHistory = new Set();
  let state = 'PROPOSED';
  let claim;
  let lastOwner;
  let lastClosureSequence = 0;
  let priorOccurredAt = Number.NEGATIVE_INFINITY;
  let reviewedSha;
  let reviewEvent;
  let acceptance;
  let acceptanceEvent;
  let attester;
  let provenanceReviewedSha = item.clean_room.author_attestation_required ? undefined : null;
  let provenanceReviewEvent;
  let doneAt;
  let terminalEvent;
  let completedClaim;

  function stopExpiredClaim(event) {
    if (!claim || !OWNED_STATES.has(state) || CLOSURE_EVENTS.has(event.type)) return;
    if (Date.parse(event.occurred_at) < Date.parse(claim.expires_at)) return;
    errors.push(`${item.id}: claim expired before ${event.type}; expiry stops work and never transfers ownership`);
    lastOwner = identity(claim);
    claim = undefined;
    state = 'READY';
    reviewedSha = undefined;
    reviewEvent = undefined;
    acceptance = undefined;
    attester = undefined;
    provenanceReviewedSha = item.clean_room.author_attestation_required ? undefined : null;
    provenanceReviewEvent = undefined;
    lastClosureSequence = event.sequence - 1;
  }

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!object(event)) {
      errors.push(`${item.id}: evidence entry ${index + 1} is not an object`);
      continue;
    }
    if (event.sequence !== index + 1) {
      errors.push(`${item.id}: evidence sequence must be contiguous from one`);
    }
    if (eventIds.has(event.event_id)) errors.push(`${item.id}: evidence event IDs must be unique`);
    eventIds.add(event.event_id);
    if (event.work_item_id !== item.id) errors.push(`${item.id}: evidence item binding is invalid`);

    const occurredAt = Date.parse(event.occurred_at);
    if (Number.isNaN(occurredAt)) {
      errors.push(`${item.id}: evidence occurred_at is invalid`);
    } else if (occurredAt < priorOccurredAt) {
      errors.push(`${item.id}: evidence occurred_at must be monotonic`);
    } else {
      priorOccurredAt = occurredAt;
    }

    validateActor(event.actor, principals, errors, item.id, 'event actor');
    if (event.operation_actor) {
      validateActor(event.operation_actor, principals, errors, item.id, 'operation actor');
    }
    stopExpiredClaim(event);

    if (event.type === 'STATE_TRANSITION') {
      if (state !== event.from_state || !legalTransition(event.from_state, event.to_state)) {
        errors.push(`${item.id}: generic transition is illegal or bypasses typed ownership`);
        continue;
      }
      if (event.from_state === 'IN_REVIEW' && event.to_state === 'DONE') {
        if (
          !claim ||
          !reviewedSha ||
          provenanceReviewedSha === undefined ||
          !requiredChecksPass(item, acceptance)
        ) {
          errors.push(`${item.id}: DONE requires an active claim through reviewed exact acceptance`);
          continue;
        }
        doneAt = event.occurred_at;
        terminalEvent = event;
        completedClaim = claim;
        lastOwner = identity(claim);
        claim = undefined;
        lastClosureSequence = event.sequence;
      }
      state = event.to_state;
      if (state === 'IN_REVIEW') {
        reviewedSha = undefined;
        reviewEvent = undefined;
        acceptance = undefined;
      }
      continue;
    }

    if (event.type === 'CLAIM_REQUEST') {
      const valid =
        state === 'READY' &&
        sameIdentity(event.actor, event.request) &&
        Date.parse(event.request.expires_at) > occurredAt &&
        !requests.has(event.request.claim_id) &&
        !claimHistory.has(event.request.claim_id);
      if (!valid) {
        errors.push(`${item.id}: claim request must be new, READY, exact-scoped, future-dated, and owner-authored`);
      }
      if (!requests.has(event.request.claim_id)) {
        requests.set(event.request.claim_id, { request: event.request, event, valid });
      }
      continue;
    }

    if (event.type === 'CLAIM') {
      const requested = requests.get(event.claim.claim_id);
      const valid =
        state === 'READY' &&
        !claim &&
        lastClosureSequence === 0 &&
        sameIdentity(event.actor, event.claim) &&
        requested?.valid === true &&
        requested.event.sequence < event.sequence &&
        !consumedRequests.has(event.claim.claim_id) &&
        same(requested.request, requestPayload(event.claim)) &&
        same(claimScope(event.claim), item.scope) &&
        Date.parse(event.claim.expires_at) > occurredAt;
      if (!valid) {
        errors.push(`${item.id}: activation must exactly match one unconsumed prior request and its owner actor`);
        continue;
      }
      consumedRequests.add(event.claim.claim_id);
      claimHistory.add(event.claim.claim_id);
      claim = event.claim;
      state = 'CLAIMED';
      reviewedSha = undefined;
      reviewEvent = undefined;
      acceptance = undefined;
      attester = undefined;
      provenanceReviewedSha = item.clean_room.author_attestation_required ? undefined : null;
      provenanceReviewEvent = undefined;
      continue;
    }

    if (event.type === 'OPERATION_REQUEST') {
      let valid = sameIdentity(event.actor, event.operation_actor) && !operationRequests.has(event.operation_id);
      if (!valid) {
        errors.push(`${item.id}: operation request must be unique and authored by its exact operation actor`);
      }
      if (event.operation_type === 'RENEW' || CLOSURE_EVENTS.has(event.operation_type)) {
        valid =
          valid &&
          OWNED_STATES.has(state) &&
          claim &&
          sameIdentity(event.operation_actor, claim) &&
          event.proposal.target_claim_id === claim.claim_id &&
          (event.operation_type === 'RENEW' || event.proposal.from_state === state);
        if (!valid) {
          errors.push(`${item.id}: owner operation request must target the exact active claim and state`);
        }
      } else if (event.operation_type === 'RECLAIM') {
        const requested = requests.get(event.proposal.target_request_id);
        const activeMaintainer =
          event.operation_actor?.kind === 'maintainer' &&
          principals.activeMaintainers?.has(event.operation_actor.principal) === true;
        valid =
          valid &&
          state === 'READY' &&
          !claim &&
          lastClosureSequence > 0 &&
          activeMaintainer &&
          requested?.valid === true &&
          requested.event.sequence > lastClosureSequence &&
          same(requested.request, requestPayload(event.proposal.claim));
        if (!valid) {
          errors.push(`${item.id}: reclaim operation request requires active O1 authority and the exact later claimant request`);
        }
      } else if (event.operation_type === 'WORK_ITEM_AMENDMENT') {
        valid =
          valid &&
          state !== 'DONE' &&
          state !== 'CANCELLED' &&
          event.proposal.before_metadata_sha256 !== event.proposal.after_metadata_sha256;
        if (!valid) {
          errors.push(`${item.id}: amendment operation request requires non-terminal distinct metadata digests`);
        }
      }
      if (!operationRequests.has(event.operation_id)) {
        operationRequests.set(event.operation_id, {
          event,
          valid,
          state,
          claim_id: claim?.claim_id,
          claim: claim ? structuredClone(claim) : undefined,
          last_closure_sequence: lastClosureSequence,
        });
      }
      continue;
    }

    function consumeOperationRequest(operationEvent) {
      const requested = operationRequests.get(operationEvent.operation_id);
      const exact =
        requested?.valid === true &&
        requested.event.sequence < operationEvent.sequence &&
        requested.event.event_id === operationEvent.operation_request_event_id &&
        requested.event.operation_type === operationEvent.type &&
        sameIdentity(requested.event.operation_actor, operationEvent.operation_actor) &&
        requested.event.reason === operationEvent.reason &&
        same(requested.event.proposal, reviewedOperationProposal(operationEvent)) &&
        !consumedOperationRequests.has(operationEvent.operation_id);
      let fresh = false;
      if (exact && (operationEvent.type === 'RENEW' || CLOSURE_EVENTS.has(operationEvent.type))) {
        fresh =
          OWNED_STATES.has(state) &&
          claim?.claim_id === requested.claim_id &&
          state === requested.state &&
          same(claim, requested.claim);
      } else if (exact && operationEvent.type === 'RECLAIM') {
        fresh =
          state === 'READY' &&
          !claim &&
          lastClosureSequence === requested.last_closure_sequence;
      } else if (exact && operationEvent.type === 'WORK_ITEM_AMENDMENT') {
        fresh =
          state !== 'DONE' &&
          state !== 'CANCELLED' &&
          state === requested.state &&
          same(claim, requested.claim);
      }
      if (!exact || !fresh) {
        errors.push(`${item.id}: reviewed operation must exactly consume one fresh prior operation request`);
        return false;
      }
      consumedOperationRequests.add(operationEvent.operation_id);
      return true;
    }

    if (event.type === 'RENEW') {
      const renewal = event.renewal;
      validateReview(event, claim, event.operation_actor, principals, errors, item.id, 'renewal');
      const valid =
        consumeOperationRequest(event) &&
        OWNED_STATES.has(state) &&
        claim &&
        sameIdentity(event.operation_actor, claim) &&
        sameIdentity(renewal, claim) &&
        renewal.claim_id === claim.claim_id &&
        same(claimScope(renewal), claimScope(claim)) &&
        Date.parse(renewal.expires_at) > Date.parse(claim.expires_at) &&
        Date.parse(renewal.expires_at) > occurredAt;
      if (!valid) {
        errors.push(`${item.id}: renewal must be independently reviewed and exactly extend the active owner and scope`);
      } else {
        claim = { ...claim, expires_at: renewal.expires_at };
      }
      continue;
    }

    if (CLOSURE_EVENTS.has(event.type)) {
      validateReview(event, claim, event.operation_actor, principals, errors, item.id, 'closure');
      const valid =
        consumeOperationRequest(event) &&
        OWNED_STATES.has(state) &&
        claim &&
        state === event.from_state &&
        event.target_claim_id === claim.claim_id &&
        sameIdentity(event.operation_actor, claim);
      if (!valid) {
        errors.push(`${item.id}: typed closure must be performed by the exact active owner`);
        continue;
      }
      lastOwner = identity(claim);
      claim = undefined;
      state = event.type === 'PAUSE' ? 'BLOCKED' : event.type === 'CANCEL_CLAIM' ? 'CANCELLED' : 'READY';
      reviewedSha = undefined;
      reviewEvent = undefined;
      acceptance = undefined;
      lastClosureSequence = event.sequence;
      continue;
    }

    if (event.type === 'RECLAIM') {
      const requested = requests.get(event.claim.claim_id);
      validateReview(event, lastOwner, event.operation_actor, principals, errors, item.id, 'reclaim');
      if (identityConflicts(event.review, event.claim)) {
        errors.push(`${item.id}: reclaim reviewer must be independent of the new claimant`);
      }
      const activeMaintainer =
        event.operation_actor?.kind === 'maintainer' &&
        principals.activeMaintainers?.has(event.operation_actor.principal) === true;
      const valid =
        consumeOperationRequest(event) &&
        state === 'READY' &&
        !claim &&
        lastClosureSequence > 0 &&
        requested?.valid === true &&
        requested.event.sequence > lastClosureSequence &&
        !consumedRequests.has(event.claim.claim_id) &&
        !claimHistory.has(event.claim.claim_id) &&
        same(requested.request, requestPayload(event.claim)) &&
        same(claimScope(event.claim), item.scope) &&
        Date.parse(event.claim.expires_at) > occurredAt &&
        activeMaintainer;
      if (!valid) {
        errors.push(`${item.id}: reclaim needs a prior closure, a new later request, active O1 maintainer operation, and independent review`);
        continue;
      }
      consumedRequests.add(event.claim.claim_id);
      claimHistory.add(event.claim.claim_id);
      claim = event.claim;
      state = 'CLAIMED';
      reviewedSha = undefined;
      reviewEvent = undefined;
      acceptance = undefined;
      attester = undefined;
      provenanceReviewedSha = item.clean_room.author_attestation_required ? undefined : null;
      provenanceReviewEvent = undefined;
      continue;
    }

    if (event.type === 'REVIEW') {
      validateReview(event, claim, undefined, principals, errors, item.id, 'work review');
      if (state !== 'IN_REVIEW' || !claim) {
        errors.push(`${item.id}: work review requires an active IN_REVIEW claim`);
      } else {
        reviewedSha = event.reviewed_sha;
        reviewEvent = event;
      }
      continue;
    }

    if (event.type === 'PROVENANCE_ATTESTATION') {
      if (!OWNED_STATES.has(state) || !claim || !sameIdentity(event.actor, claim)) {
        errors.push(`${item.id}: provenance attestation must come from the active author/owner`);
      } else {
        attester = identity(event.actor);
        provenanceReviewedSha = item.clean_room.author_attestation_required ? undefined : null;
      }
      continue;
    }

    if (event.type === 'PROVENANCE_REVIEW') {
      validateReview(event, claim, undefined, principals, errors, item.id, 'provenance review');
      const reviewerIsHuman =
        event.review?.kind === 'human' && validateActor(event.review, principals, [], item.id, 'provenance reviewer');
      if (
        !OWNED_STATES.has(state) ||
        !claim ||
        !attester ||
        !reviewerIsHuman ||
        identityConflicts(event.review, attester)
      ) {
        errors.push(`${item.id}: provenance review requires an independent registered human after attestation`);
      } else {
        provenanceReviewedSha = event.reviewed_sha;
        provenanceReviewEvent = event;
      }
      continue;
    }

    if (event.type === 'ACCEPTANCE') {
      if (
        state !== 'IN_REVIEW' ||
        !claim ||
        !reviewedSha ||
        provenanceReviewedSha === undefined ||
        event.acceptance.tested_sha !== reviewedSha ||
        event.acceptance.merged_sha !== reviewedSha ||
        (item.clean_room.author_attestation_required && provenanceReviewedSha !== reviewedSha) ||
        !requiredChecksPass(item, event.acceptance)
      ) {
        errors.push(`${item.id}: acceptance requires active reviewed work, provenance, exact SHA, and every required passed check`);
      } else {
        acceptance = event.acceptance;
        acceptanceEvent = event;
      }
      continue;
    }

    if (event.type === 'WORK_ITEM_AMENDMENT') {
      validateReview(event, claim, event.operation_actor, principals, errors, item.id, 'work item amendment');
      const requested = consumeOperationRequest(event);
      if (state === 'DONE' || state === 'CANCELLED') {
        errors.push(`${item.id}: work item amendment is forbidden after a terminal transition`);
        continue;
      }
      if (event.before_metadata_sha256 === event.after_metadata_sha256) {
        errors.push(`${item.id}: work item amendment must bind different before and after metadata hashes`);
      }
      if (requested) amendments.push(event);
      continue;
    }

    errors.push(`${item.id}: unknown evidence type ${event.type}`);

    if (!OWNED_STATES.has(state) && claim) {
      errors.push(`${item.id}: active claim cannot survive a non-owned state`);
      claim = undefined;
    }
  }

  if (state !== item.state) errors.push(`${item.id}: replayed state differs from item state`);
  const lastAmendmentSequence = amendments.at(-1)?.sequence ?? 0;
  for (const { request, event } of requests.values()) {
    if (
      event.sequence > lastAmendmentSequence &&
      !same(claimScope(request), item.scope)
    ) {
      errors.push(`${item.id}: current claim request scope must exactly match current item scope`);
    }
  }
  if (OWNED_STATES.has(state)) {
    if (!claim || Date.parse(claim.expires_at) <= now.getTime()) {
      errors.push(`${item.id}: owned state requires a current unexpired active claim`);
    }
    if (claim && !same(claimScope(claim), item.scope)) {
      errors.push(`${item.id}: active claim scope must exactly match current item scope`);
    }
  } else if (claim) {
    errors.push(`${item.id}: active claim cannot survive a non-owned state`);
  }
  if (state === 'DONE' && (!acceptance || !doneAt || !requiredChecksPass(item, acceptance))) {
    errors.push(`${item.id}: DONE requires reviewed acceptance with exact tested/merged SHA and passed required checks`);
  }

  return {
    errors,
    state,
    claim,
    acceptance,
    acceptanceEvent,
    requests,
    consumedRequests,
    operationRequests,
    consumedOperationRequests,
    amendments,
    reviewedSha,
    reviewEvent,
    provenanceReviewedSha,
    provenanceReviewEvent,
    doneAt,
    terminalEvent,
    completedClaim,
  };
}

function dependencyErrors(records, items) {
  const errors = [];
  const byId = new Map(records.map((record) => [record.item.id, record]));

  for (const record of records) {
    for (const dependency of record.item.dependencies) {
      if (!items.has(dependency)) errors.push(`${record.item.id}: missing dependency ${dependency}`);
      if (dependency === record.item.id) errors.push(`${record.item.id}: dependency cycle includes itself`);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(id, stack) {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      errors.push(`dependency cycle: ${[...stack.slice(start), id].join(' -> ')}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const item = items.get(id);
    for (const dependency of item?.dependencies ?? []) {
      if (items.has(dependency)) visit(dependency, [...stack, id]);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of items.keys()) visit(id, []);

  for (const record of records) {
    const requiringEvents = record.events.filter(
      (event) =>
        (event.type === 'STATE_TRANSITION' && event.to_state === 'READY') ||
        event.type === 'CLAIM' ||
        event.type === 'RECLAIM',
    );
    for (const dependency of record.item.dependencies) {
      const dependencyRecord = byId.get(dependency);
      if (!dependencyRecord) continue;
      if (
        ['READY', 'CLAIMED', 'IN_REVIEW', 'DONE'].includes(record.item.state) &&
        dependencyRecord.item.state !== 'DONE'
      ) {
        errors.push(`${record.item.id}: dependency ${dependency} is not satisfied`);
      }
      for (const event of requiringEvents) {
        if (
          !dependencyRecord.replay.doneAt ||
          Date.parse(dependencyRecord.replay.doneAt) > Date.parse(event.occurred_at)
        ) {
          errors.push(
            `${record.item.id}: dependency ${dependency} was not satisfied before ${event.type}`,
          );
        }
      }
    }
  }
  return [...new Set(errors)];
}

export function loadLedger(root, { now = new Date() } = {}) {
  const errors = [];
  const ajv = ajv2020();
  const validateItem = ajv.compile(
    JSON.parse(readFileSync(join(root, 'work/schema/work-item.schema.json'), 'utf8')),
  );
  const validateEvent = ajv.compile(
    JSON.parse(readFileSync(join(root, 'work/schema/work-evidence.schema.json'), 'utf8')),
  );
  const items = new Map();
  const parsedItems = new Map();
  const records = [];
  const itemDirectory = join(root, 'work/items');

  for (const entry of entries(itemDirectory)) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const path = join(itemDirectory, entry.name);
    let parsed;
    try {
      parsed = parseWorkItemMarkdown(readFileSync(path, 'utf8'), relative(root, path));
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    const item = parsed.metadata;
    if (!validateItem(item)) {
      errors.push(`${relative(root, path)}: invalid closed work item metadata`);
      continue;
    }
    if (
      entry.name !== `${item.id}.md` ||
      items.has(item.id) ||
      item.scope.paths.some((pathScope) => !validScopePath(pathScope))
    ) {
      errors.push(`${item.id}: item ID, filename, or scope is invalid`);
    }
    items.set(item.id, item);
    parsedItems.set(item.id, { ...parsed, path: relative(root, path) });
  }

  const evidenceRoot = join(root, 'work/evidence');
  for (const entry of entries(evidenceRoot)) {
    if (!entry.isDirectory() || !items.has(entry.name)) {
      errors.push(`work/evidence/${entry.name}: orphan, symlinked, or nested evidence`);
    }
  }

  let principals;
  try {
    principals = loadPrincipals(root);
  } catch (error) {
    errors.push(error.message);
    principals = new Map();
  }
  const globalEventIds = new Map();

  for (const item of items.values()) {
    const directory = join(evidenceRoot, item.id);
    const events = [];
    for (const entry of entries(directory)) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        errors.push(`work/evidence/${item.id}/${entry.name}: evidence must be a regular JSON file`);
        continue;
      }
      const path = join(directory, entry.name);
      const text = readFileSync(path, 'utf8');
      let event;
      try {
        event = JSON.parse(text);
      } catch {
        errors.push(`${relative(root, path)}: invalid JSON`);
        continue;
      }
      if (!validateEvent(event)) {
        errors.push(`${relative(root, path)}: invalid closed event variant`);
        continue;
      }
      if (text !== `${JSON.stringify(event, null, 2)}\n`) {
        errors.push(`${relative(root, path)}: evidence JSON must use exact canonical formatting`);
      }
      if (
        event.work_item_id !== item.id ||
        entry.name !== `${String(event.sequence).padStart(4, '0')}-${event.event_id}.json`
      ) {
        errors.push(`${relative(root, path)}: invalid item/filename/content binding`);
      }
      const duplicatePath = globalEventIds.get(event.event_id);
      if (duplicatePath) {
        errors.push(`${relative(root, path)}: event ID duplicates ${duplicatePath}`);
      } else {
        globalEventIds.set(event.event_id, relative(root, path));
      }
      events.push(event);
    }
    events.sort((left, right) => left.sequence - right.sequence);
    const replay = replayEvidence(item, events, now, principals);
    errors.push(...replay.errors);
    records.push({ item, parsedItem: parsedItems.get(item.id), events, replay });
  }

  errors.push(...dependencyErrors(records, items));

  const active = records.filter(
    (record) => OWNED_STATES.has(record.item.state) && object(record.replay.claim),
  );
  for (let left = 0; left < active.length; left += 1) {
    for (let right = left + 1; right < active.length; right += 1) {
      if (scopesOverlap(active[left].replay.claim, active[right].replay.claim)) {
        errors.push(`${active[left].item.id}/${active[right].item.id}: active claims overlap`);
      }
    }
  }

  return { errors, items, parsedItems, records, principals };
}

export function renderClaimPullRequest(item, request) {
  if (!request) throw new Error('A claim request is required.');
  return `# Claim request ${request.claim_id}\n\nThis request does not create ownership. After this claim-only change is merged, a separate activation commit records its existing Git SHA.\n\n- Item: \`work/items/${item.id}.md\`\n- Owner: \`${request.principal}\` / \`${request.github_actor}\`\n- Base: \`${request.base_sha}\`\n- Branch: \`${request.branch}\`\n- Worktree: \`${request.worktree}\`\n`;
}
