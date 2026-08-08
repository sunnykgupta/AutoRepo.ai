# Agent Instructions

Automation working in this repository must follow these rules.

## Scope and authority

- Make only the requested, reviewable changes. Do not rewrite unrelated files
  or generate broad formatting churn.
- Git-tracked policy and evidence are canonical. Do not claim work, approvals,
  releases, provider state, or integration delivery that is not recorded.
- O1, O2, and O3 are human authorities. An agent cannot hold an authority,
  approve its own work, or approve a security exception.
- O1 and O2 are distinct even when both are held by Sunny R Gupta during
  bootstrap. A security exception requires a second independent human or stays
  blocked.

## Clean-room and confidentiality

- Independently author all public content. Do not copy or closely paraphrase
  restricted source material.
- Never add source locators, commits, paths, names, manifests, private URLs,
  credentials, provider identifiers, private data, or delivery history to this
  repository.
- Do not quote suspicious material in public issues, pull requests, comments,
  or logs. Stop and route potential security exposure to O2.
- If the author has had restricted-source access, require a per-work-item
  clean-room attestation and independent review by a non-author.

## Delivery restrictions

- Run focused tests or structural validation for changed behavior and report
  the actual results.
- Keep package names within `@autorepo/*`; do not infer package names from the
  product name.
- Jira and Confluence v1 behavior is fake-only and non-canonical: no live
  credentials, transport, destination IDs, writes, publication, or reverse
  sync.
- Do not perform managed Cloudflare, Railway, or Supabase writes. O3 is
  unassigned and inactive. Read-only discovery and local/CI work remain
  separate from managed writes.
- GitHub Private Vulnerability Reporting is active and provider read-back verified.
  Preserve that claim only while the provider-setting read-back and O2 ownership
  records remain current. Do not make response-time promises.

Read [GOVERNANCE.md](GOVERNANCE.md),
[governance/clean-room-policy.md](governance/clean-room-policy.md), and the
delivery/dependency policies before implementing a material change.
