# techContext

## Stack
- **Runtime:** Node 18+ (uses `??`, `process.removeAllListeners`).
- **Language:** JavaScript ESM (`.mjs`). No TypeScript, no transpile step.
- **Std-lib only:** `node:child_process`, `node:fs`, `node:os`, `node:path`, `node:url`. No `package.json`, no npm deps.
- **External binary:** `codex` CLI on PATH, authenticated against a ChatGPT plan via `codex login`.
- **Image model:** `gpt-image-2` (codex picks quality automatically).

## Constraints
- **Zero npm deps.** Adding any is a non-starter without explicit approval.
- **Single-file runtime.** The wrapper must stay one ~300-line `.mjs`.
- **Env hygiene.**
  - DELETE `OPENAI_API_KEY` from the spawned env (forces ChatGPT-subscription billing).
  - DO NOT override `CODEX_HOME` (codex auth lives there).
- **Serial-by-design.** No concurrent invocations; codex#11435 corrupts state under parallel sessions when `CODEX_HOME` is shared.
- **Windows quirks.**
  - `codex` installs as `codex.cmd` via npm. Spawning `.cmd` post-CVE-2024-27980 requires `shell:true` (else EINVAL).
  - `shell:true` triggers DEP0190 — suppressed via `process.removeAllListeners('warning')` and a filtered handler. Args are static + a path with no shell metachars, so this is safe here.
  - Under `shell:true`, Node concatenates argv without escaping → multi-word prompts split. Mitigated by piping the prompt via stdin instead of passing it as an argv positional.
- **Output sandbox.** `codex exec --cd <outputDir>` confines codex's `workspace-write` permission to that dir.

## Setup
```bash
git clone https://github.com/NicholasMTElliott/codex-image-gen.git
cd codex-image-gen
node install.mjs           # install
node install.mjs --uninstall  # remove
```
Installer paths:
- Tool: `~/.codex-image-gen/codex-image-gen.mjs`
- Skill: `~/.claude/skills/codex-image-gen/SKILL.md`
- Settings patch: `~/.claude/settings.json` → `permissions.allow` += `Bash(node <SCRIPT_PATH> *)`

## Dependencies (tree)
- Required at runtime: `node` ≥ 18, `codex` CLI on PATH, ChatGPT auth (`codex login`).
- Optional: Claude Code (only needed for the auto-invoked skill).

## Tooling patterns
- **CLI shape:** `--style`, `--subject` required; `--generate`, `--select` optional with int validation. `-h`/`--help` prints usage to stdout and exits 0 (POSIX convention — pipeable). Usage-due-to-error (missing required arg, invalid number) prints to stderr and exits 2.
- **Output contract:** JSON on stdout via `emit()`. Always the same shape. Exit code 0 iff `ok`.
- **Error model:** all failure paths route through `emit(..., 1)` with a populated `error` or non-empty `warnings`. No partial JSON, no half-written stdout.
- **Path style:** prompts to codex use posix-slash absolute paths (`replace(/\\/g,'/')`); fs operations use `path.join` natively.
- **Image discovery:** `listImages(dir)` filters by `\.(png|jpe?g|webp)$/i`, sorts by mtime ascending. Fallback to `~/.codex/generated_images/` only if requested dir is empty (with warning).
- **Session dir naming:** `<timestamp>-<pid>` under `<cwd>/.codex-image-gen-tmp/`. Caller adds `.codex-image-gen-tmp/` to their `.gitignore` (this repo already does).
- **Settings patcher (`install.mjs`):** idempotent — re-runs are no-ops; tolerates missing/malformed settings.json by printing the rule instead of crashing.

## Repo files (entry points)
- `codex-image-gen.mjs` — runtime tool (executable, shebang `node`).
- `install.mjs` — installer (executable, shebang `node`).
- `SKILL.md` — Claude Code skill template with `<<INSTALL_PATH>>` / `<<SCRIPT_PATH>>` placeholders.
- `README.md` — user-facing docs.
- `AGENTS.md` / `CLAUDE.md` — agent-facing instructions; CLAUDE.md is a one-line `@AGENTS.md` re-export.
- `.gitignore` — pre-includes `.codex-image-gen-tmp/`.
- `LICENSE` — MIT.
