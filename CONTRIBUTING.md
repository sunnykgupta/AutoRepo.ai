# Contributing to AutoRepo.ai

Thank you for helping improve AutoRepo.ai. Contributions are reviewed Git
changes; a branch, chat message, or external tracker entry is not canonical
project state.

## Before you start

1. Read [GOVERNANCE.md](GOVERNANCE.md), [AGENTS.md](AGENTS.md), and the
   [clean-room policy](governance/clean-room-policy.md).
2. Check the delivery and dependency policies for scope, ordering, and review
   requirements.
3. Discuss material changes in the repository's GitHub collaboration surface
   before investing substantial effort. Do not disclose security details there;
   use the active, read-back-verified GitHub Private Vulnerability Reporting
   route in [SECURITY.md](SECURITY.md) instead.

The canonical work-item ledger is introduced in a later governance phase. Until
then, maintainers may require a focused issue or pull request description that
states the proposed outcome, dependencies, changed paths, validation, and
clean-room provenance.

## Clean-room contribution rules

Write independently. Do not copy, closely paraphrase, or import confidential
or source-restricted prose, code, tests, prompts, designs, assets, identifiers,
history, or metadata. Do not place suspicious material in an issue, pull
request, or public log.

Contributors who have had access to restricted source material must include a
per-work-item author clean-room attestation. A reviewer who did not author the
change must independently review its provenance and scan findings. Authors and
executing agents cannot approve their own similarity exception.

## Pull requests

Keep each pull request focused and include:

- the problem and acceptance criteria;
- paths and package scope affected;
- dependencies and any ordering constraints;
- tests or other validation actually run, with results;
- documentation changes when behavior or policy changes; and
- the required clean-room attestation and independent-review information.

Do not add secrets, private URLs, provider resource identifiers, unmanaged
binaries, generated build output, or live Jira/Confluence integration code.
Use full, immutable action references in workflow changes and preserve
least-privilege permissions.

## Review and merge

Changes require an independent reviewer and passing applicable checks. A
maintainer may reject or request a redesign for safety, provenance, licensing,
scope, or maintainability reasons. Unresolved clean-room or security findings
block merge.

By contributing, you agree that your contribution is offered under the MIT
License and that you will follow the [Code of Conduct](CODE_OF_CONDUCT.md).
