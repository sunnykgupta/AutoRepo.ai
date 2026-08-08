import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { scanFile } from './scan-clean-room.mjs';

function inTemporaryDirectory(callback) {
  const directory = mkdtempSync(join(tmpdir(), 'autorepo-clean-room-'));
  const originalDirectory = process.cwd();
  try {
    process.chdir(directory);
    callback();
  } finally {
    process.chdir(originalDirectory);
    rmSync(directory, { recursive: true, force: true });
  }
}

test('reports credential-bearing filenames without printing file content', () => {
  inTemporaryDirectory(() => {
    writeFileSync('.env', 'VALUE=not-a-secret\n');
    assert.deepEqual(scanFile('.env'), [{ path: '.env', category: 'prohibited credential-bearing filename' }]);
  });
});

test('scans the allowed example environment filename for credential markers', () => {
  inTemporaryDirectory(() => {
    writeFileSync('.env.example', `TOKEN=${['ghp', 'abcdefghijklmnopqrstuvwxyz123456'].join('_')}\n`);
    assert.deepEqual(scanFile('.env.example'), [{ path: '.env.example', category: 'GitHub token' }]);
  });
});

test('fails closed for oversized tracked content', () => {
  inTemporaryDirectory(() => {
    writeFileSync('large.txt', 'x'.repeat(1_000_001));
    assert.deepEqual(scanFile('large.txt'), [{ path: 'large.txt', category: 'oversized file requires a dedicated scan' }]);
  });
});

test('fails closed for binary and archive content', () => {
  inTemporaryDirectory(() => {
    writeFileSync('binary.dat', Buffer.from([0, 1, 2]));
    writeFileSync('archive.zip', Buffer.from('PK\x03\x04'));
    assert.deepEqual(scanFile('binary.dat'), [{ path: 'binary.dat', category: 'unsupported binary requires a dedicated scan' }]);
    assert.deepEqual(scanFile('archive.zip'), [{ path: 'archive.zip', category: 'unsupported archive requires a dedicated scan' }]);
  });
});
