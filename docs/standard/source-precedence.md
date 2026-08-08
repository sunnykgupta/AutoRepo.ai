---
title: Source precedence
document_type: standard
status: active
canonical_sources:
  - governance policy
  - work item
  - append-only evidence
---

# Source precedence

Git-tracked governance policy is authoritative. A canonical work item at `work/items/<ID>.md` defines bounded work. Append-only JSON evidence under `work/evidence/<ID>/` proves state changes, claims, reviews, and acceptance.

Generated status and dependency views are informative projections and must be regenerated from Git. Jira and Confluence previews are non-canonical fakes. Neither can change Git records. A branch, worktree, issue, comment, chat message, preview, or elapsed claim lease is not canonical ownership or delivery evidence.

Work-item front matter is hash-addressed canonical metadata. After bootstrap,
an ID cannot change. An exact state-only update is explained by its newly added
typed state/claim/closure evidence and does not require a second amendment
event. Every other metadata change requires a newly added, independently
reviewed `WORK_ITEM_AMENDMENT` that binds the exact before and after hashes.
The amendment initiator first authenticates a request-only `OPERATION_REQUEST`;
a later independent reviewer consumes that exact merged request commit.
Item prose can change only under a current active claim covering the item path.

When records disagree, stop affected work and correct the reviewed Git record.
G2a coordination mechanics are non-release and not alpha-eligible.
