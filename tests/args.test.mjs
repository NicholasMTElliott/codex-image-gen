import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mktempDir, runTool } from './helpers.mjs';

test('1. --help exits 0 with usage on stdout', async () => {
  // POSIX convention: explicit --help goes to stdout (so users can pipe it).
  // Usage-due-to-error (missing required arg) goes to stderr — see tests 2 & 3.
  const r = await runTool(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /--style/);
  assert.match(r.stdout, /--subject/);
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

test('5a. --name with disallowed chars is rejected', async () => {
  // Path traversal / shell-meta surprises blocked at the boundary.
  const r = await runTool(['--style', 's', '--subject', 'x', '--name', '../evil']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--name must contain only/);
});

test('5b. --style + --style-file together is rejected', async () => {
  const dir = mktempDir('cig-prompt-');
  const f = join(dir, 'style.txt');
  writeFileSync(f, 'from-file');
  const r = await runTool(['--style', 'inline', '--style-file', f, '--subject', 'x']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--style and --style-file are mutually exclusive/);
});

test('5c. --subject + --subject-file together is rejected', async () => {
  const dir = mktempDir('cig-prompt-');
  const f = join(dir, 'subject.txt');
  writeFileSync(f, 'from-file');
  const r = await runTool(['--style', 's', '--subject', 'inline', '--subject-file', f]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--subject and --subject-file are mutually exclusive/);
});

test('5d. --style-file pointing at a missing file is rejected', async () => {
  const dir = mktempDir('cig-prompt-');
  const r = await runTool(['--style-file', join(dir, 'nope.txt'), '--subject', 'x']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /failed to read --style-file/);
});

test('5e. --style-file with whitespace-only content is rejected as empty', async () => {
  const dir = mktempDir('cig-prompt-');
  const f = join(dir, 'blank.txt');
  writeFileSync(f, '   \n\n  \t\n');
  const r = await runTool(['--style-file', f, '--subject', 'x']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /is empty/);
});

test('5f. --aspect with invalid value is rejected with allowed list', async () => {
  const r = await runTool(['--style', 's', '--subject', 'x', '--aspect', 'wide']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--aspect must be one of: square, portrait, landscape/);
  assert.match(r.stderr, /got "wide"/);
});
