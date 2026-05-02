/**
 * Shared test helpers — temp dirs, fake-codex shim setup, tool runner.
 */

import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, '..');
export const TOOL_PATH = join(REPO_ROOT, 'codex-image-gen.mjs');
export const INSTALL_PATH = join(REPO_ROOT, 'install.mjs');
export const SKILL_TEMPLATE_PATH = join(REPO_ROOT, 'SKILL.md');
export const FAKE_CODEX_SCRIPT = join(__dirname, 'fake-codex', 'codex.mjs');

const IS_WIN = process.platform === 'win32';

export function mktempDir(prefix = 'cig-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Build a one-shot directory containing a `codex` (POSIX) or `codex.cmd`
 * (Windows) shim that delegates to our fake-codex Node script. Returns the
 * path to that directory, suitable for prepending to PATH.
 */
let cachedShimDir = null;
export function getShimDir() {
  if (cachedShimDir) return cachedShimDir;
  const dir = mktempDir('cig-shim-');
  if (IS_WIN) {
    // %~dp0 expands to script dir; %* forwards all args.
    writeFileSync(
      join(dir, 'codex.cmd'),
      `@node "${FAKE_CODEX_SCRIPT}" %*\r\n`,
    );
  } else {
    const shim = join(dir, 'codex');
    writeFileSync(shim, `#!/bin/sh\nexec node "${FAKE_CODEX_SCRIPT}" "$@"\n`);
    chmodSync(shim, 0o755);
  }
  cachedShimDir = dir;
  return dir;
}

/**
 * Run codex-image-gen.mjs with a fake-codex shim on PATH.
 *
 * @param {string[]} args            CLI args for the tool
 * @param {object}   opts
 * @param {string}   opts.cwd        Working dir (default: fresh temp dir)
 * @param {object}   opts.env        Extra env vars (overrides defaults)
 * @param {object}   opts.fakeEnv    FAKE_CODEX_* env vars passed through to the stub
 * @param {boolean}  opts.useRealCodex  Bypass the shim (for live-smoke tests)
 *
 * @returns {Promise<{
 *   stdout: string,
 *   stderr: string,
 *   code: number | null,
 *   json: object | null,
 *   cwd: string,
 * }>}
 */
export function runTool(args, opts = {}) {
  const cwd = opts.cwd ?? mktempDir('cig-cwd-');
  const baseEnv = { ...process.env, ...(opts.env ?? {}), ...(opts.fakeEnv ?? {}) };
  if (!opts.useRealCodex) {
    const shim = getShimDir();
    baseEnv.PATH = shim + delimiter + (baseEnv.PATH ?? '');
  }
  return spawnAndCapture(process.execPath, [TOOL_PATH, ...args], { cwd, env: baseEnv })
    .then((r) => ({ ...r, cwd }));
}

/**
 * Run install.mjs with a fake-codex shim on PATH and HOME/USERPROFILE
 * redirected to a temp dir.
 *
 * @param {object}   opts
 * @param {string}   opts.home      Override HOME (default: fresh temp dir)
 * @param {string[]} opts.args      CLI args (e.g. ['--uninstall'])
 * @param {object}   opts.env       Extra env vars
 *
 * @returns {Promise<{stdout, stderr, code, home}>}
 */
export function runInstaller(opts = {}) {
  const home = opts.home ?? mktempDir('cig-home-');
  const baseEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ...(opts.env ?? {}),
  };
  const shim = getShimDir();
  baseEnv.PATH = shim + delimiter + (baseEnv.PATH ?? '');
  return spawnAndCapture(process.execPath, [INSTALL_PATH, ...(opts.args ?? [])], { env: baseEnv })
    .then((r) => ({ ...r, home }));
}

function spawnAndCapture(cmd, args, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => resolve({ stdout, stderr, code: -1, json: null, error: e.message }));
    child.on('close', (code) => {
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* not JSON, fine */ }
      resolve({ stdout, stderr, code, json });
    });
  });
}

/**
 * Read the fake-codex meta dump from a tool run's session output dir.
 * Returns null if not found.
 */
export function readFakeCodexMeta(workdir) {
  const path = join(workdir, 'output', '.fake-codex-meta.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}
