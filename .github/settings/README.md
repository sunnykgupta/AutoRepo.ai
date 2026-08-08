# GitHub settings evidence

`../rulesets/main.json` and `../environments/release.json` are **desired-state
contracts**. They name the `main` ruleset and `release` environment that an
authorized maintainer may configure; they do not prove that either exists live.

`verified-live.json` is the repository's live-settings evidence record. The
current read-back records matched GitHub Private Vulnerability Reporting and
zero observed main rulesets/release environments with an **authorized-deferred**
status. It must be changed only after a new authenticated settings read-back;
do not infer live state from a desired contract or a workflow run.
