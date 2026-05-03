/**
 * Live smoke test — exercises the real codex CLI against the user's actual
 * ChatGPT subscription. Burns ~1 image's worth of quota per run.
 *
 * Gated on TEST_LIVE=1. Skipped by default so `npm test` and CI don't trip it.
 *
 * Run manually with:
 *   TEST_LIVE=1 npm run test:live
 *
 * Pre-reqs:
 *   - codex CLI on PATH, authed (`codex login` complete)
 *   - paid ChatGPT plan (Plus / Pro / Team)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTool } from './helpers.mjs';

const SKIP = process.env.TEST_LIVE !== '1';
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function assertValidPng(path) {
  const bytes = readFileSync(path);
  assert.ok(bytes.length > 100, `PNG suspiciously small: ${bytes.length} bytes`);
  assert.equal(bytes[0], 0x89, 'PNG byte 0');
  assert.equal(bytes[1], 0x50, 'PNG byte 1 (P)');
  assert.equal(bytes[2], 0x4E, 'PNG byte 2 (N)');
  assert.equal(bytes[3], 0x47, 'PNG byte 3 (G)');
}

test('25. live smoke: real codex 1×1 generation produces a valid PNG', { skip: SKIP }, async () => {
  const r = await runTool(
    [
      '--style', 'studio product photo, soft lighting, white background',
      '--subject', 'a single red apple, centered, no scene',
    ],
    { useRealCodex: true },
  );

  assert.equal(r.code, 0, `tool failed: ${JSON.stringify(r.json ?? r.stderr)}`);
  assert.ok(r.json, 'expected JSON output');
  assert.equal(r.json.ok, true, `ok=false, warnings=${JSON.stringify(r.json.warnings)}, error=${r.json.error ?? '<none>'}`);
  assert.equal(r.json.mode, 'generate');
  assert.equal(r.json.generated.count, 1);
  assert.equal(r.json.selected.count, 1);

  assertValidPng(r.json.selected.paths[0]);

  // Real generation should take meaningfully longer than a fake-codex run.
  assert.ok(r.json.durationMs > 5000, `durationMs suspiciously fast: ${r.json.durationMs}`);
});

test('63. live smoke: real codex edit mode applies pose from one ref to character from another', async (t) => {
  if (SKIP) { t.skip('TEST_LIVE!=1'); return; }
  const alien = join(REPO_ROOT, 'examples', 'alien.png');
  const pose = join(REPO_ROOT, 'examples', 'pose.png');
  if (!existsSync(alien) || !existsSync(pose)) {
    t.skip(`live edit smoke skipped: missing fixtures (looked at ${alien} and ${pose})`);
    return;
  }
  const r = await runTool(
    [
      'edit',
      '--reference', alien,
      '--reference', pose,
      '--instruction',
        'Render the character of @alien.png in the pose of @pose.png. ' +
        'Match @alien.png\'s style and character EXACTLY. ' +
        'Match @pose.png\'s pose ONLY (do not adopt its line-art style).',
      '--name', 'live-smoke-edit',
    ],
    { useRealCodex: true },
  );

  assert.equal(r.code, 0, `tool failed: ${JSON.stringify(r.json ?? r.stderr)}`);
  assert.ok(r.json, 'expected JSON output');
  assert.equal(r.json.ok, true, `ok=false, warnings=${JSON.stringify(r.json.warnings)}, error=${r.json.error ?? '<none>'}`);
  assert.equal(r.json.mode, 'edit');
  assert.equal(r.json.generated.count, 1);
  assert.equal(r.json.selected.count, 1);
  assert.equal(r.json.references.length, 2);
  assert.ok(r.json.references.every((x) => x.referenced));
  assert.match(r.json.instruction.resolved, /references\/alien\.png/);
  assert.match(r.json.instruction.resolved, /references\/pose\.png/);

  assertValidPng(r.json.selected.paths[0]);
  assert.ok(r.json.durationMs > 5000, `durationMs suspiciously fast: ${r.json.durationMs}`);
});
