import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFakeCodexMeta, runTool } from './helpers.mjs';

test('12. spawned codex env has OPENAI_API_KEY deleted (subscription billing lock)', async () => {
  const r = await runTool(
    // --debug preserves the tmp workdir so we can read the fake-codex meta dump.
    ['--style', 's', '--subject', 'x', '--debug'],
    { env: { OPENAI_API_KEY: 'sk-fake-must-not-leak-to-codex' } },
  );
  assert.equal(r.json.ok, true);
  const meta = readFakeCodexMeta(r.json.workdir);
  assert.equal(meta.env.OPENAI_API_KEY, null,
    'codex must not see OPENAI_API_KEY — would silently switch to API billing');
});

test('13. spawned codex env preserves CODEX_HOME (auth lives there)', async () => {
  const r = await runTool(
    ['--style', 's', '--subject', 'x', '--debug'],
    { env: { CODEX_HOME: '/some/custom/codex/home' } },
  );
  assert.equal(r.json.ok, true);
  const meta = readFakeCodexMeta(r.json.workdir);
  assert.equal(meta.env.CODEX_HOME, '/some/custom/codex/home',
    'tool must NOT override CODEX_HOME — would orphan the user\'s ChatGPT auth');
});
