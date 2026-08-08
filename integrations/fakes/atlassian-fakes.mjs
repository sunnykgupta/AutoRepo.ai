import { createHash } from 'node:crypto';

export const PREVIEW_NOTICE = 'NON-CANONICAL — FAKE — NO DESTINATION WRITE';

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function clone(value) { return structuredClone(value); }

/** A deterministic in-memory preview model with no connection capability. */
export class StatefulProjectionFake {
  #records = new Map();
  #failNext = false;

  constructor(kind) { this.kind = kind; }
  failNext() { this.#failNext = true; }
  preview(canonical) {
    if (this.#failNext) { this.#failNext = false; throw new Error(`${this.kind} fake failure`); }
    const source = clone(canonical);
    const fingerprint = digest(source);
    const previous = this.#records.get(source.id);
    const expected = this.render(source);
    const action = !previous ? 'created' : previous.fingerprint === fingerprint && digest(previous.preview) === digest(expected) ? 'noop' : 'updated';
    if (action !== 'noop') this.#records.set(source.id, { fingerprint, source, preview: expected });
    return { action, notice: PREVIEW_NOTICE, preview: clone(this.#records.get(source.id).preview) };
  }
  render(source) { return { kind: this.kind, canonical_id: source.id, state: source.state, notice: PREVIEW_NOTICE }; }
  inspect(id) { return this.#records.has(id) ? clone(this.#records.get(id).preview) : undefined; }
  tamper(id, patch) {
    const record = this.#records.get(id);
    if (!record) throw new Error('Cannot alter a missing fake preview.');
    record.preview = { ...record.preview, ...clone(patch) };
  }
  reconcile(canonical) { return this.preview(canonical); }
}
export class JiraProjectionFake extends StatefulProjectionFake {
  constructor() { super('Jira preview'); }
  render(source) { return { ...super.render(source), summary: source.title, dependencies: [...source.dependencies] }; }
}
export class ConfluenceRenderFake extends StatefulProjectionFake {
  constructor() { super('Confluence preview'); }
  render(source) { return { ...super.render(source), heading: source.title, body: `State: ${source.state}` }; }
}
