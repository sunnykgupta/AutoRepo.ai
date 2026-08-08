# Governance

## Canonical authority

Git-tracked policies, approvals, work items, and evidence are canonical.
GitHub interfaces may help people collaborate, but they do not replace a
reviewed Git record. Jira and Confluence are fake-only, non-canonical v1
projections; no live destination write or reverse synchronization is allowed.

The current G1 policy files are:

- [`governance/owners.yaml`](governance/owners.yaml): named authorities and
  current activation state.
- [`governance/delivery-policy.yaml`](governance/delivery-policy.yaml): change,
  review, evidence, and release baseline.
- [`governance/dependency-policy.yaml`](governance/dependency-policy.yaml):
  dependency and scope rules.
- [`governance/clean-room-policy.md`](governance/clean-room-policy.md): public
  provenance and scan requirements.

## Operational authorities

The roles below are separate authorities with separate records and permissions.
One person may hold O1 and O2 only during the approved bootstrap, without
collapsing their responsibilities.

| Authority | Responsibility | Current state |
| --- | --- | --- |
| O1 — program/release | Governance, program/release decisions, and protected-main or release-control approval | Active: Sunny R Gupta (`sunnykgupta`) |
| O2 — security | Security disposition, private-reporting route verification, and security exceptions | Active: Sunny R Gupta (`sunnykgupta`); GitHub Private Vulnerability Reporting is active and read-back verified |
| O3 — cloud-cost/teardown | Managed-provider cost, expiry, resource scope, and teardown approval | Unassigned and inactive |

O3 is mandatory before any create, change, delete, rotation, deployment apply,
or DNS mutation involving managed Cloudflare, Railway, or Supabase resources.
It is not needed for local-only work, local/CI resources, read-only provider
discovery, or GitHub settings operations authorized by G0 and O1.

No security exception can be self-approved. It requires a second independent
human reviewer; if none is available, the exception is blocked.

## Repository settings evidence

GitHub Private Vulnerability Reporting is active and provider read-back
verified. The desired `main` ruleset and release environment each have a target
count of one, but the read-back observed zero of each. They are authorized
deferred controls, not active controls, and the settings comparison is not a
global match. See
[`governance/evidence/repository-settings.json`](governance/evidence/repository-settings.json)
for the per-setting desired/live comparison.

## Decisions, changes, and evidence

Changes must follow the delivery and dependency policies. Later phases add the
canonical work-item and append-only evidence ledger. Until then, reviewable Git
changes must still state scope, dependencies, validation, provenance, and the
authority used for an operational decision.

Policies change through reviewed Git. A policy conflict or ambiguity blocks the
affected action until O1 resolves provenance/delivery questions or O2 resolves
security impact. Managed-provider actions also require O3.

## Gate posture

G0 approval is recorded in `governance/approvals/G0-v2.yaml`. G1 establishes
the public governance baseline and the active, read-back-verified GitHub
Private Vulnerability Reporting route. It does not activate the desired-only
ruleset or release environment, managed-provider access, deployment, or later
release gates.
