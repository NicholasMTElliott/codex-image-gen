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
import { readFileSync } from 'node:fs';
import { runTool } from './helpers.mjs';

const SKIP = process.env.TEST_LIVE !== '1';

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
  assert.equal(r.json.generated.count, 1);
  assert.equal(r.json.selected.count, 1);

  // Verify the PNG: file should exist and start with the PNG magic bytes.
  const pngPath = r.json.selected.paths[0];
  const bytes = readFileSync(pngPath);
  assert.ok(bytes.length > 100, `PNG suspiciously small: ${bytes.length} bytes`);
  assert.equal(bytes[0], 0x89, 'PNG byte 0');
  assert.equal(bytes[1], 0x50, 'PNG byte 1 (P)');
  assert.equal(bytes[2], 0x4E, 'PNG byte 2 (N)');
  assert.equal(bytes[3], 0x47, 'PNG byte 3 (G)');

  // Real generation should take meaningfully longer than a fake-codex run.
  assert.ok(r.json.durationMs > 5000, `durationMs suspiciously fast: ${r.json.durationMs}`);
});
