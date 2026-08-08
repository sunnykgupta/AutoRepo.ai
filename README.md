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

## License

AutoRepo.ai is licensed under the [MIT License](LICENSE). See [NOTICE.md](NOTICE.md)
for baseline notices.
