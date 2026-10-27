/**
 * codex CLI flag contract.
 *
 * Fake-codex half (always runs): the fake rejects unknown flags, and the tool
 * spawns `codex exec` with the current sandbox flag, never `--full-auto`.
 *
 * Real-codex half (runs only when a real `codex` is on PATH; CI usually has
 * none): every flag the tool emits must appear in `codex exec --help`, and the
 * real parser must accept the exact argv (checked with a trailing `--help`,
 * which clap only honors after validating the earlier args — no quota spent).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FAKE_CODEX_SCRIPT, mktempDir, readFakeCodexMeta, runTool } from './helpers.mjs';
import { CODEX_EXEC_FLAGS, CODEX_EXEC_FLAGS_VERSION } from './fake-codex/exec-flags.mjs';

const IS_WIN = process.platform === 'win32';

function runFake(args, cwd) {
  return spawnSync(process.execPath, [FAKE_CODEX_SCRIPT, ...args], {
    cwd,
    input: 'generate 1 bitmap raster image',
    encoding: 'utf8',
  });
}

/** Emitted argv from one fake-codex run of the tool (both modes share runCodex). */
async function emittedArgv() {
  const r = await runTool(['--style', 's', '--subject', 'x', '--debug']);
  assert.equal(r.json?.ok, true, `tool run failed: ${r.stdout}${r.stderr}`);
  const meta = readFakeCodexMeta(r.json.workdir);
  assert.ok(meta, 'fake-codex meta missing');
  return meta.argv;
}

function flagsOf(argv) {
  return argv.filter((a) => a.startsWith('-') && a !== '-').map((a) => a.split('=')[0]);
}

// ---------- real codex discovery ----------

// Windows needs a shell for the codex.cmd shim; pass one quoted command
// string (shell:true plus an args array triggers DEP0190).
function runRealCodex(args) {
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 };
  if (!IS_WIN) return spawnSync('codex', args, opts);
  const cmd = ['codex', ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ');
  return spawnSync(cmd, { ...opts, shell: true });
}

function findRealCodex() {
  const v = runRealCodex(['--version']);
  const version = v.status === 0 ? (v.stdout ?? '').trim().match(/^codex-cli (\S+)/)?.[1] : null;
  if (!version) return null; // not installed, or the fake shim (prints "fake-codex")
  const h = runRealCodex(['exec', '--help']);
  if (h.status !== 0 || !/Usage: codex exec/.test(h.stdout)) return null;
  return { version, help: h.stdout };
}

/** Option names and `--sandbox` values listed in `codex exec --help`. */
function parseHelp(help) {
  const options = help.slice(help.indexOf('\nOptions:'));
  const flags = new Set();
  for (const line of options.split(/\r?\n/)) {
    const m = line.match(/^\s+(?:(-[A-Za-z0-9]),\s+)?(--[A-Za-z0-9][\w-]*)/);
    if (!m) continue;
    if (m[1]) flags.add(m[1]);
    flags.add(m[2]);
  }
  const sandboxBlock = options.slice(options.indexOf('--sandbox'));
  const sandboxModes = (sandboxBlock.match(/\[possible values: ([^\]]+)\]/)?.[1] ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return { flags, sandboxModes };
}

const real = findRealCodex();
const SKIP_REAL = real ? false : 'no real codex CLI on PATH';

// ---------- fake-codex half ----------

test('66. fake codex rejects an unknown exec flag (exit 2, nothing written)', () => {
  const dir = mktempDir('cig-fakeflag-');
  const r = runFake(['exec', '--full-auto', '--skip-git-repo-check', '--cd', dir], dir);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stderr=${r.stderr}`);
  assert.match(r.stderr, /unexpected argument '--full-auto' found/);
  assert.equal(existsSync(join(dir, '.fake-codex-meta.json')), false, 'fake must fail before writing');
});

test('67. fake codex rejects an invalid --sandbox value and accepts the allowlisted flags', () => {
  const dir = mktempDir('cig-fakeflag-');
  const bad = runFake(['exec', '--sandbox', 'yolo', '--cd', dir], dir);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /invalid value 'yolo'/);

  const ok = runFake(['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--cd', dir], dir);
  assert.equal(ok.status, 0, `stderr=${ok.stderr}`);
});

test('68. tool spawns `codex exec --sandbox workspace-write`, never --full-auto', async () => {
  const argv = await emittedArgv();
  assert.equal(argv[0], 'exec');
  const i = argv.indexOf('--sandbox');
  assert.ok(i > 0, `--sandbox missing from ${JSON.stringify(argv)}`);
  assert.equal(argv[i + 1], 'workspace-write');
  assert.ok(!argv.includes('--full-auto'), '--full-auto was removed from codex exec');
});

// ---------- real-codex half ----------

test('69. contract: every flag the tool emits is listed in the real `codex exec --help`', { skip: SKIP_REAL }, async () => {
  const { flags, sandboxModes } = parseHelp(real.help);
  const argv = await emittedArgv();
  for (const flag of flagsOf(argv.slice(1))) {
    assert.ok(flags.has(flag), `codex ${real.version} exec --help does not list ${flag}`);
  }
  const sandbox = argv[argv.indexOf('--sandbox') + 1];
  assert.ok(sandboxModes.includes(sandbox),
    `codex ${real.version} --sandbox values are [${sandboxModes}], tool sends ${sandbox}`);

  // The real parser validates every arg before honoring a trailing --help.
  const r = runRealCodex([...argv, '--help']);
  assert.equal(r.status, 0, `codex ${real.version} rejected the tool's argv: ${r.stderr}`);
});

test('70. contract: fake-codex allowlist matches the real `codex exec --help` it was taken from', { skip: SKIP_REAL }, (t) => {
  if (real.version !== CODEX_EXEC_FLAGS_VERSION) {
    t.skip(`allowlist is from codex ${CODEX_EXEC_FLAGS_VERSION}, installed ${real.version}; re-derive tests/fake-codex/exec-flags.mjs`);
    return;
  }
  const { flags } = parseHelp(real.help);
  assert.deepEqual([...CODEX_EXEC_FLAGS.keys()].sort(), [...flags].sort());
});
