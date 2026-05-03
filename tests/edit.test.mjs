import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mktempDir, readFakeCodexMeta, runTool } from './helpers.mjs';

// Tests cover the new `edit` subcommand: --reference staging, --instruction
// with @-token resolution + validation, JSON shape additions (mode,
// references[], instruction.raw/resolved), and backward-compat behavior of
// the implicit/explicit `generate` subcommand.

// Minimal PNG-ish bytes (validation only checks extension; magic isn't required).
const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function makeRef(dir, name) {
  const p = join(dir, name);
  writeFileSync(p, FAKE_PNG);
  return p;
}

test('40. edit happy path: single ref + @-instruction → ok=true, mode=edit, references populated', async () => {
  const refsDir = mktempDir('cig-refs-');
  const a = makeRef(refsDir, 'alien.png');
  const r = await runTool([
    'edit',
    '--reference', a,
    '--instruction', 'Render @alien.png in a different pose.',
  ]);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.mode, 'edit');
  assert.equal(r.json.generated.count, 1);
  assert.equal(r.json.selected.count, 1);
  assert.equal(r.json.references.length, 1);
  assert.equal(r.json.references[0].source, a);
  assert.equal(r.json.references[0].staged, 'alien.png');
  assert.equal(r.json.references[0].referenced, true);
  assert.equal(r.json.instruction.raw, 'Render @alien.png in a different pose.');
  assert.equal(r.json.instruction.resolved, 'Render references/alien.png in a different pose.');
});

test('41. edit with multiple refs and @-tokens → all referenced, prompt contains both staged paths', async () => {
  const refsDir = mktempDir('cig-refs-');
  const a = makeRef(refsDir, 'alien.png');
  const p = makeRef(refsDir, 'pose.png');
  const r = await runTool([
    'edit',
    '--reference', a,
    '--reference', p,
    '--instruction', 'Match the character of @alien.png in the pose of @pose.png.',
    '--debug',
  ]);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.references.length, 2);
  assert.ok(r.json.references.every((x) => x.referenced));
  const meta = readFakeCodexMeta(r.json.workdir);
  assert.match(meta.prompt, /references\/alien\.png/);
  assert.match(meta.prompt, /references\/pose\.png/);
  // Resolved instruction in the prompt must NOT contain the raw @-token form
  // (substitution happened before the prompt was built).
  assert.doesNotMatch(meta.prompt, /@alien\.png/);
  assert.doesNotMatch(meta.prompt, /@pose\.png/);
});

test('42. edit with unknown @-token → exits 2 with helpful error and full mapping', async () => {
  const refsDir = mktempDir('cig-refs-');
  const a = makeRef(refsDir, 'alien.png');
  const r = await runTool([
    'edit',
    '--reference', a,
    '--instruction', 'Use @alient.png as reference.',
  ]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown @-token/);
  assert.match(r.stderr, /@alient\.png/);
  assert.match(r.stderr, /available staged references: alien\.png/);
});

test('43. edit missing --reference → exits 2', async () => {
  const r = await runTool([
    'edit',
    '--instruction', 'do something',
  ]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /at least one --reference/);
});

test('44. edit missing --instruction → exits 2', async () => {
  const refsDir = mktempDir('cig-refs-');
  const a = makeRef(refsDir, 'alien.png');
  const r = await runTool([
    'edit',
    '--reference', a,
  ]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /requires --instruction/);
});

test('45. edit --instruction + --instruction-file together → exits 2', async () => {
  const refsDir = mktempDir('cig-refs-');
  const a = makeRef(refsDir, 'alien.png');
  const f = join(refsDir, 'inst.txt');
  writeFileSync(f, 'do thing');
  const r = await runTool([
    'edit',
    '--reference', a,
    '--instruction', 'inline',
    '--instruction-file', f,
  ]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--instruction and --instruction-file are mutually exclusive/);
});

test('46. edit --reference for nonexistent file → exits 2', async () => {
  const r = await runTool([
    'edit',
    '--reference', '/nonexistent/path/foo.png',
    '--instruction', 'use @foo.png',
  ]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /does not exist/);
});

test('47. edit --reference with wrong extension → exits 2', async () => {
  const refsDir = mktempDir('cig-refs-');
  const bad = join(refsDir, 'data.txt');
  writeFileSync(bad, 'not an image');
  const r = await runTool([
    'edit',
    '--reference', bad,
    '--instruction', 'use @data.txt',
  ]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /extension not in/);
});

test('48. edit basename collision → second ref auto-suffixed with -2 and warning', async () => {
  const refsA = mktempDir('cig-refs-a-');
  const refsB = mktempDir('cig-refs-b-');
  const a1 = makeRef(refsA, 'cat.png');
  const a2 = makeRef(refsB, 'cat.png');
  const r = await runTool([
    'edit',
    '--reference', a1,
    '--reference', a2,
    '--instruction', 'blend @cat.png with @cat-2.png',
  ]);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.references.length, 2);
  assert.equal(r.json.references[0].staged, 'cat.png');
  assert.equal(r.json.references[1].staged, 'cat-2.png');
  assert.ok(
    r.json.warnings.some((w) => /basename collides/.test(w) && /staged as cat-2\.png/.test(w)),
    `expected collision warning, got: ${JSON.stringify(r.json.warnings)}`,
  );
});

test('49. edit duplicate reference (same path twice) → dedup with warning', async () => {
  const refsDir = mktempDir('cig-refs-');
  const a = makeRef(refsDir, 'alien.png');
  const r = await runTool([
    'edit',
    '--reference', a,
    '--reference', a,
    '--instruction', 'use @alien.png',
  ]);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.references.length, 1, 'duplicates should be dedup\'d');
  assert.ok(
    r.json.warnings.some((w) => /duplicate of an earlier reference/.test(w)),
    `expected dedup warning, got: ${JSON.stringify(r.json.warnings)}`,
  );
});

test('50. edit unreferenced ref (passed but not @-mentioned) → warning, not error', async () => {
  const refsDir = mktempDir('cig-refs-');
  const a = makeRef(refsDir, 'alien.png');
  const p = makeRef(refsDir, 'pose.png');
  const r = await runTool([
    'edit',
    '--reference', a,
    '--reference', p,
    '--instruction', 'transform @alien.png',
  ]);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.references.find((x) => x.staged === 'alien.png').referenced, true);
  assert.equal(r.json.references.find((x) => x.staged === 'pose.png').referenced, false);
  assert.ok(
    r.json.warnings.some((w) => /pose\.png was not @-mentioned/.test(w)),
    `expected unreferenced warning, got: ${JSON.stringify(r.json.warnings)}`,
  );
});

test('51. edit references actually copied into <sessionDir>/output/references/ (--debug)', async () => {
  const refsDir = mktempDir('cig-refs-');
  const a = makeRef(refsDir, 'alien.png');
  const r = await runTool([
    'edit',
    '--reference', a,
    '--instruction', 'use @alien.png',
    '--debug',
  ]);
  assert.equal(r.json.ok, true);
  const stagedPath = join(r.json.workdir, 'output', 'references', 'alien.png');
  assert.ok(existsSync(stagedPath), `staged reference should exist at ${stagedPath}`);
});

test('52. edit prompt structure: contains "Reference images" section and Instructions section (--debug)', async () => {
  const refsDir = mktempDir('cig-refs-');
  const a = makeRef(refsDir, 'alien.png');
  const r = await runTool([
    'edit',
    '--reference', a,
    '--instruction', 'distinct-edit-marker-XYZ using @alien.png',
    '--debug',
  ]);
  const meta = readFakeCodexMeta(r.json.workdir);
  assert.match(meta.prompt, /Reference images available/);
  assert.match(meta.prompt, /Instructions:/);
  assert.match(meta.prompt, /distinct-edit-marker-XYZ/);
  assert.match(meta.prompt, /references\/alien\.png/);
});

test('53. edit with --generate 3 --select 1 → review step runs, 1 selected in persistent dir', async () => {
  const refsDir = mktempDir('cig-refs-');
  const a = makeRef(refsDir, 'alien.png');
  const r = await runTool([
    'edit',
    '--reference', a,
    '--instruction', 'use @alien.png',
    '--generate', '3',
    '--select', '1',
  ]);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.generated.count, 3);
  assert.equal(r.json.selected.count, 1);
  assert.ok(r.json.selected.paths[0].startsWith(r.json.outputDir));
});

test('54. edit with --name and --out lands file at <out>/<name>.png', async () => {
  const refsDir = mktempDir('cig-refs-');
  const a = makeRef(refsDir, 'alien.png');
  const r = await runTool([
    'edit',
    '--reference', a,
    '--instruction', 'use @alien.png',
    '--name', 'alien-edited',
    '--out', 'assets',
  ]);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.selected.paths[0], join(r.cwd, 'assets', 'alien-edited.png'));
});

test('55. edit with --instruction-file: contents land in resolved instruction (--debug)', async () => {
  const refsDir = mktempDir('cig-refs-');
  const a = makeRef(refsDir, 'alien.png');
  const f = join(refsDir, 'inst.md');
  writeFileSync(f, 'Take @alien.png and make it grumpy.\n');
  const r = await runTool([
    'edit',
    '--reference', a,
    '--instruction-file', f,
    '--debug',
  ]);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.instruction.raw, 'Take @alien.png and make it grumpy.');
  assert.equal(r.json.instruction.resolved, 'Take references/alien.png and make it grumpy.');
});

test('56. explicit `generate` subcommand still works (mode=generate in JSON)', async () => {
  const r = await runTool(['generate', '--style', 's', '--subject', 'x']);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.mode, 'generate');
});

test('57. flag-only invocation (no subcommand) defaults to generate mode', async () => {
  const r = await runTool(['--style', 's', '--subject', 'x']);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.mode, 'generate');
});

test('58. unknown subcommand exits 2', async () => {
  const r = await runTool(['nonsense', '--style', 's', '--subject', 'x']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown subcommand "nonsense"/);
});

test('59. generate-mode rejects edit-only flags with a per-mode error', async () => {
  const r = await runTool(['--style', 's', '--subject', 'x', '--reference', 'foo.png']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown argument "--reference" for generate mode/);
});

test('60. edit-mode rejects generate-only flags with a per-mode error', async () => {
  const refsDir = mktempDir('cig-refs-');
  const a = makeRef(refsDir, 'alien.png');
  const r = await runTool([
    'edit',
    '--reference', a,
    '--instruction', 'use @alien.png',
    '--style', 'studio photo',
  ]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown argument "--style" for edit mode/);
});

test('61. @-token boundary: trailing punctuation does not poison the substitution', async () => {
  const refsDir = mktempDir('cig-refs-');
  const a = makeRef(refsDir, 'alien.png');
  const r = await runTool([
    'edit',
    '--reference', a,
    '--instruction', 'Look at @alien.png, then describe it.',
    '--debug',
  ]);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.instruction.resolved, 'Look at references/alien.png, then describe it.');
});

test('62. edit-mode --help exits 0 with usage on stdout (mentions edit subcommand)', async () => {
  const r = await runTool(['edit', '--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /edit mode/);
  assert.match(r.stdout, /--reference/);
  assert.match(r.stdout, /--instruction/);
});

// Tests 64 + 65 are source-inspection guards. We can't deterministically
// trigger the staging-failure path or the last-resort main().catch from
// out-of-process in a portable way (would require sub-millisecond TOCTOU
// races, cross-platform permission tweaks, or NUL-byte argv smuggling that
// spawn filters out). The guards fail loudly if a future refactor drops
// the try/catch around stageReferences or narrows the JSON shape emitted
// from the top-level catch.

test('64. staging failure routes through buildResult (source guard)', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'codex-image-gen.mjs'),
    'utf8',
  );
  assert.match(src, /try\s*\{\s*stageReferences\(/, 'stageReferences must be wrapped in try/catch');
  assert.match(src, /failed to stage references/, 'staging-failure error must thread through buildResult');
});

test('65. top-level catch JSON includes mode + outputDir (source guard)', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'codex-image-gen.mjs'),
    'utf8',
  );
  const m = src.match(/main\(\)\.catch\(\(e\) => \{([\s\S]*?)\n\}\);/);
  assert.ok(m, 'expected to locate main().catch handler');
  const body = m[1];
  assert.match(body, /\bmode:/, 'top-level catch must include mode field');
  assert.match(body, /\boutputDir:/, 'top-level catch must include outputDir field');
});
