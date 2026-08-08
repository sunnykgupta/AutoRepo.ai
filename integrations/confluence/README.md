# Confluence preview contract

`ConfluenceRenderFake` renders an in-memory, provider-neutral document preview from Git-canonical work data. Every result is visibly **NON-CANONICAL — FAKE — NO DESTINATION WRITE**.

The fake supports deterministic create, update, no-op, injected failure, drift repair, and reconciliation exercises. It contains no connection capability, accepts no credentials, performs no destination writes, has no remote identifier mapping, and exposes no reverse mutation path. Editing a fake preview cannot alter Git records.
