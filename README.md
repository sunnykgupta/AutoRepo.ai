# AutoRepo.ai

AutoRepo.ai is a public, MIT-licensed foundation for building a governed,
provider-portable SaaS application and its accompanying documentation.

The repository is in its governed bootstrap phase. Git-tracked policies and
evidence are the canonical record for decisions and delivery. GitHub-rendered
files are the public documentation path until a later, separately approved
deployment gate.

## Current baseline

- License holder: Sunny R Gupta.
- Package namespace: `@autorepo/*` only. Package names use lowercase letters,
  digits, and hyphens after the scope.
- Locked v1 stack: Node.js 24, npm 11, Astro, React/Vite, NestJS with Fastify,
  Prisma with reviewed SQL, Turborepo, PostgreSQL 17, and pg-boss.
- Jira and Confluence are fake-only, non-canonical integrations in v1. No live
  destination, credentials, transport, publication, or reverse sync is in
  scope.
- Managed Cloudflare, Railway, and Supabase resources must not be created,
  changed, or deleted without active O3 authority. O3 is currently inactive.

## Start here

1. Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change.
2. Follow the clean-room rules in
   [governance/clean-room-policy.md](governance/clean-room-policy.md).
3. Review the decision and authority model in [GOVERNANCE.md](GOVERNANCE.md)
   and [MAINTAINERS.md](MAINTAINERS.md).
4. Give automation the restrictions in [AGENTS.md](AGENTS.md).

The delivery and dependency baseline is defined in
[`governance/delivery-policy.yaml`](governance/delivery-policy.yaml) and
[`governance/dependency-policy.yaml`](governance/dependency-policy.yaml).

## Security and support

GitHub Private Vulnerability Reporting is active and verified by provider
read-back. See [SECURITY.md](SECURITY.md) before disclosing a vulnerability.
General help and non-security questions are covered by [SUPPORT.md](SUPPORT.md).

## Status

G0 approval is recorded at
[`governance/approvals/G0-v2.yaml`](governance/approvals/G0-v2.yaml). This G1
baseline establishes repository governance and does not claim that later
runtime, deployment, or release capabilities already exist.

G2a coordination mechanics are non-release and not alpha-eligible. Its desired
GitHub ruleset is not live until O1 activates it and records a read-back; hosted
workflow results are therefore not yet a protected gate. No merge queue is
configured. The G2A bootstrap work item remains `PROPOSED`, so G2a is not
complete until a follow-up governed proof records a valid claim, review, and
acceptance history.

`npm run validate:governance` intentionally validates the local canonical
ledger, generated projections, and documentation only; it prints that Git
context was not evaluated. Use `GOVERNANCE_BASE_SHA=<full-sha> npm run
validate:governance:git` for append-only, diff, ancestry, bootstrap, claim, and
work-item immutability validation. Pull-request and merge-group workflows use
that full Git-context command and fail closed without the base SHA.

Full pull-request validation authenticates each newly added evidence event by
requiring `event.actor.github_actor` to equal the PR's `GITHUB_ACTOR`.
Merge-group validation replays the resulting history without binding the queue
actor. This is a desired workflow assurance only: the desired ruleset and
required context are not currently protected or live.

The governance workflow's push trigger is limited to `main` and uses the push
event's prior SHA as its full-validation base. A repository-creation push with
an all-zero prior SHA fails closed with an explicit no-comparable-base message.

## License

AutoRepo.ai is licensed under the [MIT License](LICENSE). See [NOTICE.md](NOTICE.md)
for baseline notices.
