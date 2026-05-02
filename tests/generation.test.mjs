import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { readFakeCodexMeta, runTool } from './helpers.mjs';

test('6. single-image happy path: ok=true, 1 generated, 1 selected, paths absolute', async () => {
  const r = await runTool(['--style', 'studio photo', '--subject', 'an apple']);
  assert.equal(r.code, 0);
  assert.ok(r.json, 'expected JSON on stdout, got: ' + r.stdout.slice(0, 200));
  assert.equal(r.json.ok, true);
  assert.equal(r.json.generated.count, 1);
  assert.equal(r.json.selected.count, 1);
  assert.equal(r.json.selected.expected, 1);
  assert.equal(r.json.generated.paths.length, 1);
  assert.ok(isAbsolute(r.json.generated.paths[0]), 'path should be absolute');
  assert.ok(existsSync(r.json.generated.paths[0]), 'generated file should exist on disk');
});

test('7. --generate 4 --select 2: 4 in output/, 2 in output/selected/', async () => {
  const r = await runTool([
    '--style', 's', '--subject', 'x',
    '--generate', '4', '--select', '2',
  ]);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.generated.count, 4);
  assert.equal(r.json.selected.count, 2);
  assert.equal(r.json.selected.expected, 2);
  for (const p of r.json.selected.paths) {
    assert.ok(p.includes('selected'), `selected path should contain 'selected/' segment: ${p}`);
    assert.ok(existsSync(p));
  }
});

test('8. --generate 4 --select 4: no review step, no selected/ dir, selected==generated', async () => {
  const r = await runTool([
    '--style', 's', '--subject', 'x',
    '--generate', '4', '--select', '4',
  ]);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.generated.count, 4);
  assert.equal(r.json.selected.count, 4);
  // No selected/ subfolder on disk
  const selectedDir = join(r.json.workdir, 'output', 'selected');
  assert.equal(existsSync(selectedDir), false, 'selected/ should not exist when select==generate');
  // selected.paths should be a subset of generated.paths (in this branch the
  // tool slices generated, so paths are identical).
  for (const p of r.json.selected.paths) {
    assert.ok(r.json.generated.paths.includes(p));
  }
});

test('9. fake codex exits 1 → ok=false, error contains stderr tail', async () => {
  const r = await runTool(
    ['--style', 's', '--subject', 'x'],
    { fakeEnv: { FAKE_CODEX_EXIT: '1', FAKE_CODEX_STDERR: 'simulated codex auth failure' } },
  );
  assert.equal(r.code, 1);
  assert.equal(r.json.ok, false);
  assert.match(r.json.error, /codex exited with code 1/);
  assert.match(r.json.error, /simulated codex auth failure/);
});

test('10. fake produces 2 when 4 requested → count-mismatch warning, ok=false', async () => {
  const r = await runTool(
    ['--style', 's', '--subject', 'x', '--generate', '4', '--select', '4'],
    { fakeEnv: { FAKE_CODEX_GENERATE: '2' } },
  );
  // Tool sees 2 PNGs, expected 4 → ok flips false (count mismatch).
  assert.equal(r.json.ok, false);
  assert.equal(r.json.generated.count, 2);
  assert.ok(
    r.json.warnings.some((w) => /expected 4 generated image\(s\), found 2/.test(w)),
    `expected count-mismatch warning, got: ${JSON.stringify(r.json.warnings)}`,
  );
});

test('11. fake skips selected/ subfolder → mtime fallback warning', async () => {
  const r = await runTool(
    ['--style', 's', '--subject', 'x', '--generate', '4', '--select', '2'],
    { fakeEnv: { FAKE_CODEX_SKIP_SELECTED: '1' } },
  );
  // Generated count is correct, but selected/ subfolder is absent → fallback.
  assert.equal(r.json.generated.count, 4);
  assert.equal(r.json.selected.count, 2, 'fallback should select first 2 by mtime');
  assert.ok(
    r.json.warnings.some((w) => /no "selected\/" subfolder/.test(w)),
    `expected selected-fallback warning, got: ${JSON.stringify(r.json.warnings)}`,
  );
  // After fallback, selected paths come from the top-level output dir, not selected/
  for (const p of r.json.selected.paths) {
    assert.ok(!p.includes('/selected/') && !p.includes('\\selected\\'),
      `fallback should pick from output/ not selected/: ${p}`);
  }
});

test('14. JSON has well-formed shape and durationMs >= 0', async () => {
  const r = await runTool(['--style', 's', '--subject', 'x']);
  assert.equal(typeof r.json.ok, 'boolean');
  assert.equal(typeof r.json.generated, 'object');
  assert.equal(typeof r.json.generated.count, 'number');
  assert.ok(Array.isArray(r.json.generated.paths));
  assert.equal(typeof r.json.selected, 'object');
  assert.equal(typeof r.json.selected.expected, 'number');
  assert.equal(typeof r.json.workdir, 'string');
  assert.ok(Array.isArray(r.json.warnings));
  assert.equal(typeof r.json.durationMs, 'number');
  assert.ok(r.json.durationMs >= 0);
});

test('15. consecutive runs produce different sessionId workdirs', async () => {
  const r1 = await runTool(['--style', 's', '--subject', 'x']);
  const r2 = await runTool(['--style', 's', '--subject', 'x']);
  assert.notEqual(r1.json.workdir, r2.json.workdir, 'sessionId should be unique per run');
});

test('16. prompt sent to codex contains style + subject verbatim', async () => {
  const r = await runTool([
    '--style', 'distinct-style-marker-AAA',
    '--subject', 'distinct-subject-marker-BBB',
  ]);
  const meta = readFakeCodexMeta(r.json.workdir);
  assert.ok(meta, 'fake-codex meta should exist');
  assert.match(meta.prompt, /distinct-style-marker-AAA/);
  assert.match(meta.prompt, /distinct-subject-marker-BBB/);
});

test('17. when select == generate, prompt contains no review/selection block', async () => {
  const eq = await runTool(['--style', 's', '--subject', 'x', '--generate', '3', '--select', '3']);
  const eqMeta = readFakeCodexMeta(eq.json.workdir);
  assert.doesNotMatch(eqMeta.prompt, /pick the \d+ strongest/);
  assert.doesNotMatch(eqMeta.prompt, /Copy the \d+ chosen/);

  const lt = await runTool(['--style', 's', '--subject', 'x', '--generate', '3', '--select', '1']);
  const ltMeta = readFakeCodexMeta(lt.json.workdir);
  assert.match(ltMeta.prompt, /pick the 1 strongest/);
  assert.match(ltMeta.prompt, /Copy the 1 chosen/);
});
