# G2a coordination mechanics report

## Gate posture

G2a provides deterministic coordination mechanics only. It is **non-release and not alpha-eligible**. It does not satisfy G2, publish a release, or establish any managed-provider capability.

The desired ruleset is not active at the host; the checked-in main ruleset is
desired-only. There is no merge queue and no protected hosted gate. Hosted
workflow checks cannot be represented as protected enforcement until O1
activates the declared ruleset and records a provider read-back.

## Deterministic evidence

Explicit local-ledger-only validation checks closed work-item and evidence
schemas, legal state replay, dependency and ownership conflicts, exact
two-stage claims and reviewed operations, exact-SHA review and acceptance records, generated
projection drift, generated ownership drift, and fake integration boundaries.
It prints that Git context was not evaluated. Full Git-context validation is a
separate command requiring a declared base SHA; that mode checks append-only
diffs, commit contents, bootstrap rules, claim request/activation ancestry, and
work-item immutability. Pull-request heads and pushes use a single-parent linear
commit chain. Merge-group validation permits only the platform-created terminal
two-parent merge over the declared base and the same linear source chain, then
validates its final tree; internal merges remain forbidden. Every transition is
revalidated, preventing mutation/restore, out-of-scope/restore,
activation/restore, and terminal/restore bypasses.

On `pull_request`, each newly added evidence event is bound to the authenticated
GitHub actor. Reviewed operation evidence must therefore be added by a PR whose
authenticated actor is the declared reviewer, not by a claimant asserting a
reviewer field. Reviewed operations consume a separately merged, request-only
`OPERATION_REQUEST` authenticated as the exact owner, active O1 maintainer, or
amendment initiator. Agent actors may be unregistered, but current event authorship
still binds to the authenticated PR actor. Merge-group validation replays
history without comparing the queue actor; the desired pull-request
`governance / coordination` context performs identity binding. The desired
ruleset is not live, so this is not claimed as protected hosted enforcement.

Full `DONE` validation structurally checks that the accepted SHA exists,
strictly descends from activation, equals the latest exact work-review SHA (and
the latest provenance-review SHA when required), precedes review and acceptance,
and is not followed by omitted claimed implementation before the terminal event. Declared check outcomes
remain canonical declarations rather than provider conclusions.

Jira and Confluence outputs remain non-canonical in-memory previews. They do not
establish delivery evidence or mutate canonical Git records.
Canonical review and check declarations are not provider proof. Full
Git-context mode verifies those declarations and ancestry in the local Git
object graph; local-ledger-only mode does not evaluate Git context. Neither
mode concludes that a hosted review, check, protection, or merge queue ran.

The fake integration runtime exercise is an in-process transport-denial
harness: it replaces browser-style transport globals and Node HTTP/HTTPS/net
connect surfaces with throwing functions before exercising both fakes. This is
not OS-level or network-namespace isolation; that stronger isolation is not
available in the current Node runtime.

G2A remains `PROPOSED` with no evidence in this bootstrap change. G2a must not
be called complete until the bootstrap lands and a follow-up governed claim,
review, and acceptance history proves the mechanics.
