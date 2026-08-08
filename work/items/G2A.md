---
schema_version: 1
id: G2A
title: Establish deterministic coordination mechanics
state: PROPOSED
dependencies: []
scope:
  packages: []
  paths:
    - governance/**
    - docs/**
    - work/**
    - scripts/docs/**
    - scripts/integration-boundary.mjs
    - scripts/governance/**
    - scripts/integrations/**
    - integrations/**
    - .github/**
    - GOVERNANCE.md
    - README.md
    - package.json
    - package-lock.json
    - tests/**
  exclusive_resources:
    - coordination-standard
acceptance:
  required_checks:
    - governance / coordination
    - governance / repository-baseline
clean_room:
  author_attestation_required: false
  provenance: independently-authored
---

# G2A — Establish deterministic coordination mechanics

## Bootstrap transition

This item is introduced as `PROPOSED` because the current branch has no merged,
reviewed canonical claim request or activation evidence. Existing local changes
are not represented as ownership, approval, or delivery evidence. A future
reviewed Git transition must establish readiness, then use the two-stage claim
request and activation protocol described in the coordination standard. G2a
becomes checkpoint-complete only after this bootstrap merge and a follow-up
governed proof; this proposed item is not delivered evidence.

## Acceptance

The eventual `DONE` transition requires the closed schemas, replay and Git
context validators, generated projections, fake-only integration boundary, and
independent reviewed acceptance evidence at exact Git SHAs.
