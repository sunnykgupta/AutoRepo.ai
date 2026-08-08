# Maintainers

## Bootstrap maintainers and authorities

| Authority | Human principal | GitHub account | Status |
| --- | --- | --- | --- |
| O1 — program/release | Sunny R Gupta | `sunnykgupta` | Active |
| O2 — security | Sunny R Gupta | `sunnykgupta` | Active; GitHub Private Vulnerability Reporting is active and read-back verified |
| O3 — cloud-cost/teardown | Unassigned | — | Inactive |

O1 and O2 are separate roles, records, and permissions even though they are
held by the same person during bootstrap. Security exceptions require a second
independent human reviewer and remain blocked until one is available. O3 must
be separately assigned and approved before a managed Cloudflare, Railway, or
Supabase write.

The machine-readable source of this table is
[`governance/owners.yaml`](governance/owners.yaml), validated by
[`governance/owners.schema.json`](governance/owners.schema.json).

## Maintainer responsibilities

- Keep public policy truthful about what is configured and active.
- Require independent review, validation evidence, and clean-room provenance.
- Keep Git as the canonical record; do not treat fake integrations as authority.
- Prevent credentials, private material, or source-restricted data from being
  exposed in public repository content.
- Record the authority exercised for decisions made by a dual-role holder.

An agent or bot may assist with implementation and checks but cannot be an
accountable authority, independently approve its own work, or approve a
security exception.
