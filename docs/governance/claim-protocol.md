---
title: Two-stage claim protocol
document_type: standard
status: active
canonical_sources:
  - work item
  - append-only evidence
---

# Two-stage claim protocol

A commit cannot truthfully contain its own final SHA. G2a therefore separates a claim request from activation:

1. A `CLAIM_REQUEST` is a claim-only reviewed Git change. It declares the exact
   base SHA, owner, GitHub actor, branch, worktree binding, scope, resource set,
   and lease intent, but cannot self-assert its eventual merge SHA. The
   worktree value is `sha256:<64 lowercase hex>` over the normalized registered
   Git worktree realpath. `npm run governance:worktree-binding` computes it
   without recording the sensitive local path.
2. After that request is merged, a later `CLAIM` activation event records the
   already-existing `request_sha`. The validator requires that commit to
   descend from the request's declared current base under the supported Git
   delivery semantics, contain the exact canonical request file, and be an
   ancestor of the later activation and checked-out `HEAD`.

A current `CLAIM` or `RECLAIM` activation change is activation-only: it may
contain the exact `READY` to `CLAIMED` item-state update, activation evidence,
any otherwise-valid amendment evidence, and byte-exact generated outputs. It
cannot carry implementation. A later implementation diff is valid only when
its declared base already contains the active claim's activation commit.

A request does not own work, and one request can activate only once. Only a
valid activation creates ownership. Competing requests may merge as requests,
but overlapping active claims fail. `RENEW` keeps the exact owner and scope,
extends (never shortens) the expiry, and requires an independent reviewed
operation. Expiry stops work; it does not transfer ownership.

Release and handoff close an existing claim to `READY`; pause closes it to
`BLOCKED`, and cancellation closes it to `CANCELLED`. A handoff never embeds a
new owner. Reclaim requires a prior closure, a new separately merged and
unconsumed request for the next claimant, an active O1 maintainer operation,
and an independent reviewer. Resume verifies the exact repository root,
branch, request ancestry, claim ID, owner/actor, worktree, packages, paths, and
exclusive resources.

Every reviewed renewal, closure, reclaim, or metadata amendment is also a
two-stage operation. First, the initiator adds an `OPERATION_REQUEST` in a
request-only PR. The request binds a unique operation ID, exact operation type,
initiator, target claim or claimant request where applicable, complete proposed
payload or metadata digests, and reason. The top-level actor must be that exact
initiator: the active owner initiates renewal and closure, while active O1
initiates reclaim. A metadata-amendment initiator authenticates its own request.
After that request commit is merged, an independent reviewer adds the reviewed
operation from a base that already contains the request. The reviewed event
binds the exact request event ID and commit SHA and must match its actor, reason,
target, and payload byte-for-byte. Requests are single-use and become stale if
their claim, state, target request, or metadata context changes.

In full `pull_request` validation, every newly added evidence file binds its
top-level `actor.github_actor` to the authenticated `GITHUB_ACTOR`. For reviewed
operations, the top-level actor is the nested reviewer, while
`operation_actor` remains the distinct owner or maintainer. Therefore review,
renewal, closure, reclaim, provenance-review, and metadata-amendment evidence
must be submitted in a PR authenticated as the declared reviewer; a claimant's
PR cannot fabricate that reviewer. The earlier `OPERATION_REQUEST` PR is
separately authenticated as its declared owner, O1 maintainer, or amendment
initiator, so a reviewer cannot fabricate the initiator either. Agent actors need not be registered humans,
but their current PR authorship is still authenticated by this exact actor
binding. Historical events are not rebound. Merge-group validation replays the
deterministic history without comparing the queue actor; authenticated identity
binding occurs on the pull-request workflow.

`REVIEW` and `PROVENANCE_REVIEW` each bind an exact `reviewed_sha`. That SHA must
exist, strictly descend from the active claim activation, and strictly precede
the review event commit. Any claimed-scope implementation after that SHA stales
the review. `DONE` retains the active claim through review and acceptance,
requires exact `tested_sha == merged_sha == latest REVIEW.reviewed_sha`, and
requires every canonical work-item check to be declared passed. Clean-room
items also require the latest provenance review to bind that same SHA. The final
`IN_REVIEW` to `DONE` transition then closes the claim. Full Git-context mode
locates the commits adding activation, review, acceptance, and the terminal
transition. The accepted SHA must include every claimed implementation change
before terminal `DONE`; later claimed-scope changes invalidate it. The
check names and statuses remain canonical declarations, not provider read-back.
Local-ledger-only mode does not evaluate these Git ranges. Neither mode turns
canonical declarations into provider proof of hosted review or check
conclusions.

Full Git-context validation inspects every introduced parent-to-commit
transition, not only the final tree. Pull-request submitted heads and pushes
must be one linear chain with one parent per commit. A `merge_group` may contain
one or more platform-created two-parent merges in a first-parent chain beginning
at the declared queue base. Each merge's source-parent history must be linear;
internal, octopus, or non-platform merges remain forbidden. Evidence
append-only rules, request and activation purity, metadata amendments,
generated files, terminal immutability, parent-ledger scope ownership, and each
deterministic platform merge tree are re-evaluated, so a later restoration
cannot hide an earlier violation.
