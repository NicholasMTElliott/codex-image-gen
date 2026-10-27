/**
 * Allowlist of `codex exec` options, copied from the real CLI's help output.
 *
 * Source: `codex exec --help`, codex-cli 0.156.1 (2026-10-27).
 *
 * The fake codex rejects any flag not listed here, the way the real CLI's
 * argument parser does. Without this the fake accepted anything, so a flag
 * removed upstream (`--full-auto`, gone by ~0.152) kept CI green while every
 * real run failed at argument parsing.
 *
 * When you bump the codex version this was taken from, re-copy the list from
 * the new help text and update the version above. tests/codex-flags.test.mjs
 * checks this list against a real `codex exec --help` when codex is on PATH.
 *
 * Value: true if the option takes a value (`--cd <DIR>`), false for a switch.
 */
export const CODEX_EXEC_FLAGS_VERSION = '0.156.1';

export const CODEX_EXEC_FLAGS = new Map([
  ['-c', true], ['--config', true],
  ['--enable', true],
  ['--disable', true],
  ['--strict-config', false],
  ['-i', true], ['--image', true],
  ['-m', true], ['--model', true],
  ['--oss', false],
  ['--local-provider', true],
  ['-p', true], ['--profile', true],
  ['-s', true], ['--sandbox', true],
  ['--approve-for-me', false],
  ['--dangerously-bypass-approvals-and-sandbox', false],
  ['--dangerously-bypass-hook-trust', false],
  ['-C', true], ['--cd', true],
  ['--worktree', false],
  ['--add-dir', true],
  ['--thread-source', true],
  ['--skip-git-repo-check', false],
  ['--ephemeral', false],
  ['--ignore-user-config', false],
  ['--ignore-rules', false],
  ['--output-schema', true],
  ['--color', true],
  ['--json', false],
  ['-o', true], ['--output-last-message', true],
  ['-h', false], ['--help', false],
  ['-V', false], ['--version', false],
]);

/** Allowed values for `--sandbox` / `-s` (same help text). */
export const CODEX_SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'];

/**
 * Validate `codex exec` argv (everything after `exec`). Returns null when
 * every flag is known, else an error string in the style of the real CLI.
 */
export function validateExecArgs(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break; // everything after is positional
    if (arg === '-' || !arg.startsWith('-')) continue; // prompt / stdin marker
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    if (!CODEX_EXEC_FLAGS.has(name)) {
      return `error: unexpected argument '${name}' found`;
    }
    if (!CODEX_EXEC_FLAGS.get(name)) continue;
    let value;
    if (name !== arg) value = arg.slice(eq + 1);
    else {
      value = args[i + 1];
      i++;
      if (value === undefined) {
        return `error: a value is required for '${name}' but none was supplied`;
      }
    }
    if ((name === '--sandbox' || name === '-s') && !CODEX_SANDBOX_MODES.includes(value)) {
      return `error: invalid value '${value}' for '${name}'`;
    }
  }
  return null;
}
