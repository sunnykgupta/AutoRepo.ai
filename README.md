# AutoRepo.ai

AutoRepo.ai is a lightweight learning guide for making repositories that keep moving when their goals are clear.

It teaches a practical habit: describe the outcome, make the next piece of work safe and inspectable, use feedback to learn, and keep people involved where judgment matters. This is not a promise of unattended software; it is a way to make useful progress easier to continue.

## Learn the loop

A self-sustaining repository repeatedly moves through seven steps:

1. **Understand** — state the outcome, constraints, and signals of success.
2. **Plan** — choose the smallest safe path and name decisions that need a person.
3. **Build** — make one bounded change with the relevant context nearby.
4. **Verify** — run checks that demonstrate the change works.
5. **Review** — inspect the result, trade-offs, and evidence.
6. **Learn** — record what changed the plan or revealed a better approach.
7. **Continue** — promote the next clear piece of work.

## Start in 10 minutes

1. Copy the four starter files into a place your contributors can find:
   - [`templates/GOAL.md`](templates/GOAL.md)
   - [`templates/WORK.md`](templates/WORK.md)
   - [`templates/DECISION.md`](templates/DECISION.md)
   - [`templates/AGENTS.md`](templates/AGENTS.md)
2. Fill in one small, user-facing goal and the first bounded work item.
3. Name the checks or review evidence that make the work complete.
4. Use the agent instructions to make escalation and intervention expectations explicit.

Need a concrete reference? [`examples/first-loop/`](examples/first-loop/) shows the same four files filled in for a small contributor-onboarding improvement. Adapt it; do not treat it as a required process.

## Site and status

The learning guide is a static Astro site. It has no accounts, runtime agents, background jobs, telemetry, or hosted control plane.

The public learning guide is available at:

<https://autorepo.ai/>

### Run the site locally

```sh
npm ci
npm run site:dev
```

Build the custom-domain Pages artifact locally:

```sh
PUBLIC_BASE_PATH=/ npm run site:build
```

Check Astro types and diagnostics:

```sh
npm run site:check
```

To run the shared preview server, use `npm run site:preview`. It binds outside
localhost and accepts only the Vorflux preview host suffix.

## Autonomy boundaries

Routine, reversible preview or staging deployments may continue when repository policy explicitly permits them. Ask for human approval before a production or public release, an irreversible or destructive action, an access or credential change, spending, a legal or security posture change, or an unclear material trade-off.

## Contribute and get help

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change.
- Report vulnerabilities privately through [SECURITY.md](SECURITY.md), not in a public issue or pull request.
- Use [SUPPORT.md](SUPPORT.md) for non-security help.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## For maintainers

Governance records remain the canonical source for project decisions and delivery. Maintainers should review [GOVERNANCE.md](GOVERNANCE.md), [AGENTS.md](AGENTS.md), the [delivery policy](governance/delivery-policy.yaml), [dependency policy](governance/dependency-policy.yaml), and [clean-room policy](governance/clean-room-policy.md) before material changes.

## License

AutoRepo.ai is licensed under the [MIT License](LICENSE). See [NOTICE.md](NOTICE.md) for notices.
