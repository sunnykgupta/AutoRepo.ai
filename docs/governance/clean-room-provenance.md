---
title: Governance clean-room provenance integration
document_type: guide
status: active
canonical_sources:
  - governance/clean-room-policy.md
  - work item clean_room metadata
---

# Clean-room provenance integration

Each work item declares whether an author attestation is required and records
its provenance posture in canonical front matter. If attestation is required,
the active author/owner must attest before acceptance and a different active,
registered governance human must independently review that provenance. The
active claim survives through both records and acceptance. Work review and
provenance review each bind an exact `reviewed_sha`; for clean-room acceptance,
both latest reviews and `tested_sha`/`merged_sha` must name the same commit. Any
later claimed-scope implementation stales both reviews and blocks acceptance.

Public work remains independently authored. Do not place restricted material, source locators, private identifiers, credentials, or scanner findings in work items, evidence, generated views, fake previews, templates, or logs. Suspected exposure stops work and follows the clean-room policy's confidential escalation path.
