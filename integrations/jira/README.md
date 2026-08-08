# Jira preview contract

`JiraProjectionFake` is an in-memory, provider-neutral projection model. Its output is visibly **NON-CANONICAL — FAKE — NO DESTINATION WRITE** and is derived one way from the Git work ledger.

The model supports deterministic create, update, no-op, injected failure, drift repair, and reconciliation exercises. It has no connection capability, accepts no credentials, performs no destination writes, has no remote identifier mapping, and exposes no reverse mutation path. A fake preview is never evidence of ownership, review, acceptance, or delivery.
