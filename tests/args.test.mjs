import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTool } from './helpers.mjs';

test('1. --help exits 0 with usage on stderr', async () => {
  const r = await runTool(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stderr, /Usage:/);
  assert.match(r.stderr, /--style/);
  assert.match(r.stderr, /--subject/);
});

test('2. missing --style exits 2 and prints usage', async () => {
  const r = await runTool(['--subject', 'a thing']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Usage:/);
});

test('3. missing --subject exits 2 and prints usage', async () => {
  const r = await runTool(['--style', 'a style']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Usage:/);
});

test('4. --generate 0 is rejected', async () => {
  const r = await runTool(['--style', 's', '--subject', 'x', '--generate', '0']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--generate must be a positive integer/);
});

test('5. --select greater than --generate is rejected', async () => {
  const r = await runTool(['--style', 's', '--subject', 'x', '--generate', '2', '--select', '5']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--select cannot exceed --generate/);
});
