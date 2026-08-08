import assert from 'node:assert/strict';
import test from 'node:test';
import { bootstrapOwner, renderCodeowners } from './generate-codeowners.mjs';

test('renders bootstrap ownership for all repository content and governance paths', () => {
  const rendered = renderCodeowners();
  assert.equal(bootstrapOwner, '@sunnykgupta');
  assert.match(rendered, /^\* @sunnykgupta$/m);
  assert.match(rendered, /^\/\.github\/ @sunnykgupta$/m);
  assert.match(rendered, /^\/governance\/ @sunnykgupta$/m);
});
