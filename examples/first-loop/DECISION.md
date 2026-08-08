# Decision: Keep the first contributor check local and deterministic

**Status:** accepted
**Date:** 2026-08-08

## Context

New contributors need an early feedback loop before they rely on hosted deployment or external services.

## Decision

Use the repository's local validation command as the first proof that a documentation-only change is ready for review.

## Consequences

- Positive: contributors get fast, repeatable feedback without provider access.
- Trade-off: a local pass does not prove a later hosted deployment succeeded.
- Revisit when: the project adds a required runtime service or browser test.
