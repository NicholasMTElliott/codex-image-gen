import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { mktempDir, readFakeCodexMeta, runTool } from './helpers.mjs';

test('6. single-image happy path: ok=true, 1 selected, paths absolute and in persistent output dir', async () => {
  const r = await runTool(['--style', 'studio photo', '--subject', 'an apple']);
  assert.equal(r.code, 0);
  assert.ok(r.json, 'expected JSON on stdout, got: ' + r.stdout.slice(0, 200));
  assert.equal(r.json.ok, true);
  assert.equal(r.json.generated.count, 1);
  assert.equal(r.json.selected.count, 1);
  assert.equal(r.json.selected.expected, 1);
  // Persistent path is in <cwd>/codex-image-gen-output/
  const expectedDir = join(r.cwd, 'codex-image-gen-output');
  assert.equal(r.json.outputDir, expectedDir);
  const selected = r.json.selected.paths[0];
  assert.ok(isAbsolute(selected));
  assert.ok(selected.startsWith(expectedDir), `selected path should be inside persistent output dir: ${selected}`);
  assert.ok(existsSync(selected), 'selected file should exist on disk');
});

test('7. --generate 4 --select 2: 2 selected files in persistent output dir, sessionId-prefixed', async () => {
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
    assert.ok(p.startsWith(r.json.outputDir), `path should be inside outputDir: ${p}`);
    // Filename should be sessionId-prefixed: <ms>-<pid>-variant-N.png
    assert.match(p, /\d+-\d+-variant-\d+\.png$/, `filename should be sessionId-prefixed: ${p}`);
    assert.ok(existsSync(p));
  }
});

test('8. --generate 4 --select 4: no review step, all 4 copied to persistent output dir', async () => {
  const r = await runTool([
    '--style', 's', '--subject', 'x',
    '--generate', '4', '--select', '4',
  ]);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.generated.count, 4);
  assert.equal(r.json.selected.count, 4);
  assert.equal(r.json.selected.paths.length, 4);
  for (const p of r.json.selected.paths) {
    assert.ok(p.startsWith(r.json.outputDir));
    assert.ok(existsSync(p));
  }
});

test('9. fake codex exits 1 → ok=false, error contains stderr tail, tmp workdir preserved', async () => {
  const r = await runTool(
    ['--style', 's', '--subject', 'x'],
    { fakeEnv: { FAKE_CODEX_EXIT: '1', FAKE_CODEX_STDERR: 'simulated codex auth failure' } },
  );
  assert.equal(r.code, 1);
  assert.equal(r.json.ok, false);
  assert.match(r.json.error, /codex exited with code 1/);
  assert.match(r.json.error, /simulated codex auth failure/);
  // Failure must preserve tmp so user can debug
  assert.ok(existsSync(r.json.workdir), 'tmp workdir should be preserved on failure');
});

test('10. fake produces 2 when 4 requested → count-mismatch warning, ok=false, tmp preserved', async () => {
  const r = await runTool(
    ['--style', 's', '--subject', 'x', '--generate', '4', '--select', '4'],
    { fakeEnv: { FAKE_CODEX_GENERATE: '2' } },
  );
  assert.equal(r.json.ok, false);
  assert.equal(r.json.generated.count, 2);
  assert.ok(
    r.json.warnings.some((w) => /expected 4 generated image\(s\), found 2/.test(w)),
    `expected count-mismatch warning, got: ${JSON.stringify(r.json.warnings)}`,
  );
  // Partial-failure should preserve tmp (user may want to inspect what came back)
  assert.ok(existsSync(r.json.workdir), 'tmp workdir should be preserved when ok=false');
});

test('11. fake skips selected/ subfolder → mtime fallback warning, fallback paths copied to persistent dir', async () => {
  const r = await runTool(
    ['--style', 's', '--subject', 'x', '--generate', '4', '--select', '2'],
    { fakeEnv: { FAKE_CODEX_SKIP_SELECTED: '1' } },
  );
  assert.equal(r.json.generated.count, 4);
  assert.equal(r.json.selected.count, 2, 'fallback should select first 2 by mtime');
  assert.ok(
    r.json.warnings.some((w) => /no "selected\/" subfolder/.test(w)),
    `expected selected-fallback warning, got: ${JSON.stringify(r.json.warnings)}`,
  );
  // After fallback + copy, selected paths live in the persistent output dir,
  // not under any 'selected/' subfolder
  for (const p of r.json.selected.paths) {
    assert.ok(p.startsWith(r.json.outputDir), `path should be in persistent output dir: ${p}`);
    assert.ok(!p.includes('/selected/') && !p.includes('\\selected\\'),
      `fallback should not retain a 'selected/' segment: ${p}`);
  }
});

test('14. JSON has well-formed shape: ok, generated, selected, outputDir, workdir, warnings, durationMs', async () => {
  const r = await runTool(['--style', 's', '--subject', 'x']);
  assert.equal(typeof r.json.ok, 'boolean');
  assert.equal(typeof r.json.generated, 'object');
  assert.equal(typeof r.json.generated.count, 'number');
  assert.ok(Array.isArray(r.json.generated.paths));
  assert.equal(typeof r.json.selected, 'object');
  assert.equal(typeof r.json.selected.expected, 'number');
  assert.equal(typeof r.json.outputDir, 'string');
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

test('16. prompt sent to codex contains style + subject verbatim (--debug to preserve meta)', async () => {
  const r = await runTool([
    '--style', 'distinct-style-marker-AAA',
    '--subject', 'distinct-subject-marker-BBB',
    '--debug',
  ]);
  const meta = readFakeCodexMeta(r.json.workdir);
  assert.ok(meta, 'fake-codex meta should exist when --debug preserves tmp');
  assert.match(meta.prompt, /distinct-style-marker-AAA/);
  assert.match(meta.prompt, /distinct-subject-marker-BBB/);
});

test('17. when select == generate, prompt contains no review/selection block (--debug to preserve meta)', async () => {
  const eq = await runTool(['--style', 's', '--subject', 'x', '--generate', '3', '--select', '3', '--debug']);
  const eqMeta = readFakeCodexMeta(eq.json.workdir);
  assert.doesNotMatch(eqMeta.prompt, /pick the \d+ strongest/);
  assert.doesNotMatch(eqMeta.prompt, /Copy the \d+ chosen/);

  const lt = await runTool(['--style', 's', '--subject', 'x', '--generate', '3', '--select', '1', '--debug']);
  const ltMeta = readFakeCodexMeta(lt.json.workdir);
  assert.match(ltMeta.prompt, /pick the 1 strongest/);
  assert.match(ltMeta.prompt, /Copy the 1 chosen/);
});

test('26. successful run cleans up tmp workdir by default', async () => {
  const r = await runTool(['--style', 's', '--subject', 'x']);
  assert.equal(r.json.ok, true);
  assert.equal(existsSync(r.json.workdir), false, 'tmp workdir should be removed on success');
  // generated.paths should be empty after cleanup (tmp paths would be stale)
  assert.deepEqual(r.json.generated.paths, [], 'generated.paths should be empty after cleanup');
  // generated.count should still report what codex actually produced
  assert.equal(r.json.generated.count, 1);
});

test('27. --debug preserves tmp workdir on success and surfaces tmp generated paths', async () => {
  const r = await runTool(['--style', 's', '--subject', 'x', '--generate', '3', '--select', '3', '--debug']);
  assert.equal(r.json.ok, true);
  assert.ok(existsSync(r.json.workdir), 'tmp workdir should be preserved with --debug');
  assert.equal(r.json.generated.paths.length, 3, '--debug should surface tmp generated paths');
  for (const p of r.json.generated.paths) {
    assert.ok(p.includes('.codex-image-gen-tmp'), `--debug generated path should be in tmp: ${p}`);
    assert.ok(existsSync(p));
  }
});

test('28. consecutive runs in the same cwd accumulate distinct files in persistent output dir', async () => {
  // Run twice in the same cwd; each run should add files that don't clobber
  // the previous run, thanks to sessionId prefix in the filename.
  const r1 = await runTool(['--style', 's', '--subject', 'x']);
  const r2 = await runTool(['--style', 's', '--subject', 'x'], { cwd: r1.cwd });
  assert.equal(r1.json.ok, true);
  assert.equal(r2.json.ok, true);
  // Both runs' selected files should still exist
  assert.ok(existsSync(r1.json.selected.paths[0]), 'run 1 selected file should still exist after run 2');
  assert.ok(existsSync(r2.json.selected.paths[0]), 'run 2 selected file should exist');
  assert.notEqual(r1.json.selected.paths[0], r2.json.selected.paths[0],
    'consecutive runs must produce distinct persistent paths');
  // Both empty into the same outputDir
  assert.equal(r1.json.outputDir, r2.json.outputDir);
  // The output dir contains both files (and only them)
  const files = readdirSync(r1.json.outputDir);
  assert.equal(files.length, 2, `expected 2 files in output dir, found: ${files.join(', ')}`);
});

test('29. persistent output dir is created at <cwd>/codex-image-gen-output/', async () => {
  const r = await runTool(['--style', 's', '--subject', 'x']);
  const expected = join(r.cwd, 'codex-image-gen-output');
  assert.equal(r.json.outputDir, expected);
  assert.ok(existsSync(expected), 'persistent output dir should exist after run');
});

test('30. --name with --select 1 produces <slug>.png (no sessionId prefix)', async () => {
  const r = await runTool(['--style', 's', '--subject', 'x', '--name', 'kharr-emblem']);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.selected.paths.length, 1);
  const p = r.json.selected.paths[0];
  assert.equal(p, join(r.json.outputDir, 'kharr-emblem.png'));
  assert.ok(existsSync(p));
});

test('31. --name with --select 2+ produces numbered <slug>-N.png', async () => {
  const r = await runTool([
    '--style', 's', '--subject', 'x',
    '--generate', '4', '--select', '2',
    '--name', 'asset',
  ]);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.selected.paths.length, 2);
  assert.deepEqual(
    r.json.selected.paths.map((p) => p.split(/[\\/]/).pop()).sort(),
    ['asset-1.png', 'asset-2.png'],
  );
  for (const p of r.json.selected.paths) assert.ok(existsSync(p));
});

test('32. --name re-run collision falls back to sessionId-disambiguated name + warning', async () => {
  const r1 = await runTool(['--style', 's', '--subject', 'x', '--name', 'thing']);
  assert.equal(r1.json.ok, true);
  // Re-run in the same cwd with the same --name → preferred path exists
  const r2 = await runTool(['--style', 's', '--subject', 'x', '--name', 'thing'], { cwd: r1.cwd });
  assert.equal(r2.json.ok, true);
  // Original keeper untouched
  assert.equal(r1.json.selected.paths[0], join(r1.json.outputDir, 'thing.png'));
  assert.ok(existsSync(r1.json.selected.paths[0]));
  // Re-run wrote a disambiguated name, NOT 'thing.png'
  const r2Path = r2.json.selected.paths[0];
  assert.notEqual(r2Path, join(r2.json.outputDir, 'thing.png'));
  assert.match(r2Path, /thing-\d+-\d+\.png$/);
  assert.ok(existsSync(r2Path));
  // And a warning about it
  assert.ok(
    r2.json.warnings.some((w) => /thing\.png already exists/.test(w)),
    `expected collision warning, got: ${JSON.stringify(r2.json.warnings)}`,
  );
});

test('33. --out with relative path resolves against cwd and is used as outputDir', async () => {
  const r = await runTool(['--style', 's', '--subject', 'x', '--out', 'assets/icons']);
  assert.equal(r.json.ok, true);
  const expected = join(r.cwd, 'assets', 'icons');
  assert.equal(r.json.outputDir, expected);
  assert.ok(existsSync(expected), '--out dir should be created');
  assert.ok(r.json.selected.paths[0].startsWith(expected));
});

test('34. --out with absolute path is honored verbatim', async () => {
  const absOut = mktempDir('cig-out-');
  const r = await runTool(['--style', 's', '--subject', 'x', '--out', absOut]);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.outputDir, absOut);
  assert.ok(r.json.selected.paths[0].startsWith(absOut));
  assert.ok(existsSync(r.json.selected.paths[0]));
});

test('35. --name + --out combine: file lives at <out>/<slug>.png', async () => {
  const r = await runTool([
    '--style', 's', '--subject', 'x',
    '--out', 'assets',
    '--name', 'logo',
  ]);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.selected.paths[0], join(r.cwd, 'assets', 'logo.png'));
  assert.ok(existsSync(r.json.selected.paths[0]));
});
