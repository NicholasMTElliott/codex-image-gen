# techContext

## Stack
- **Runtime:** Node 18+ (uses `??`, `process.removeAllListeners`).
- **Language:** JavaScript ESM (`.mjs`). No TypeScript, no transpile step.
- **Std-lib only:** `node:child_process`, `node:fs`, `node:os`, `node:path`, `node:url`. No `package.json`, no npm deps.
- **External binary:** `codex` CLI on PATH, authenticated against a ChatGPT plan via `codex login`.
- **Image model:** `gpt-image-2` via codex (codex picks quality automatically). Only three output sizes are supported: 1024×1024 (square), 1024×1536 (portrait), 1536×1024 (landscape) — selected via `--aspect`. No other sizes are honored upstream.

## Constraints
- **Zero npm deps.** Adding any is a non-starter without explicit approval.
- **Single-file runtime.** The wrapper is one `.mjs`. Keep both subcommands in this single file rather than splitting; size is allowed to grow as long as it stays comprehensible.
- **Env hygiene.**
  - DELETE `OPENAI_API_KEY` from the spawned env (forces ChatGPT-subscription billing).
  - DO NOT override `CODEX_HOME` (codex auth lives there).
- **Serial-by-design.** No concurrent invocations; codex#11435 corrupts state under parallel sessions when `CODEX_HOME` is shared.
- **Windows quirks.**
  - `codex` installs as `codex.cmd` via npm. Spawning `.cmd` post-CVE-2024-27980 requires `shell:true` (else EINVAL).
  - `shell:true` triggers DEP0190 — suppressed via `process.removeAllListeners('warning')` and a filtered handler. Args are static + a path with no shell metachars, so this is safe here.
  - Under `shell:true`, Node concatenates argv without escaping → multi-word prompts split. Mitigated by piping the prompt via stdin instead of passing it as an argv positional.
- **Output sandbox.** `codex exec --cd <outputDir>` confines codex's `workspace-write` permission to that dir.

## Codex behaviors (empirical)
- **Image generation.** Codex's built-in `image_gen` tool produces PNGs into the working directory it was `--cd`'d to. We tell it explicit filenames (`variant-1.png`, …) and a target subfolder for selection (`selected/`).
- **Image editing via reference files in cd.** As of the project's current testing window, codex's `image_gen` tool can read existing PNGs that live inside its working directory and produce edited variants from them. The `edit` mode relies on this: each `--reference` is staged at `<cd>/references/<basename>` so codex can read it, and the prompt explicitly names the staged paths.
- **`-i path` flag is unreliable.** Empirically, `codex exec -i <external-path>` did NOT make external files readable in the way needed for `image_gen` to consume them — the run failed prematurely. Do not use `-i` for reference-image plumbing; copy the file into the cd dir instead. (If a future codex version fixes this, the staging step could in principle be replaced with `-i`, but copying is portable and trivially cheap so there's no pressure to change.)
- **Generated_images fallback dir.** Codex sometimes writes generated PNGs to `~/.codex/generated_images/` instead of the cd dir; we fall back to scanning that location with a warning.

## Setup
```bash
git clone https://github.com/NicholasMTElliott/codex-image-gen.git
cd codex-image-gen
node install.mjs                                          # install (auto-detect targets)
node install.mjs --target=claude,opencode,cline,cursor    # explicit targets
node install.mjs --all                                    # install to every known target (incl. agents)
node install.mjs --no-opencode                            # exclude target from default set
node install.mjs --target=agents                          # only the cross-harness agents target
node install.mjs --list-targets                           # show targets + detection state
node install.mjs --uninstall                              # remove tool + every target's skill dir
```
Installer paths (per-target; the binary is shared):
- Tool (shared): `~/.codex-image-gen/codex-image-gen.mjs`
- Claude Code: skill at `~/.claude/skills/codex-image-gen/SKILL.md`; settings patch in `~/.claude/settings.json` → `permissions.allow` += `Bash(node <SCRIPT_PATH> *)`.
- opencode: skill at `~/.config/opencode/skills/codex-image-gen/SKILL.md`. No settings patch — opencode is permissive by default.
- Cline: skill at `~/.cline/skills/codex-image-gen/SKILL.md` (Cline's user-global Skills system per https://docs.cline.bot/customization/skills). No settings patch — Cline does not gate skill-invoked commands behind an allowlist.
- Cursor: skill at `~/.cursor/skills/codex-image-gen/SKILL.md` (per https://cursor.com/docs/skills). No settings patch. Cursor also reads compatibility paths `~/.claude/skills/` and `~/.codex/skills/`, so the Claude install is independently picked up.
- Agents (`explicitOnly`, never auto-installed): skill at `~/.agents/skills/codex-image-gen/SKILL.md`. Cross-harness shared dir read by Cursor + opencode. Auto-installing would duplicate entries in harnesses that read both their per-harness path and `~/.agents/skills/`; user must opt in via `--target=agents` or `--all`.

## Dependencies (tree)
- Required at runtime: `node` ≥ 18, `codex` CLI on PATH, ChatGPT auth (`codex login`).
- Optional (any one suffices for auto-invocation): a coding-agent harness that reads SKILL.md — Claude Code, opencode, Cline, Cursor, or any other target the installer registers with.

## Tooling patterns
- **CLI shape:** subcommand dispatch — first positional arg picks `generate` or `edit` (default `generate` if absent or flag-first, for backward compat with 0.2.x callers).
  - `generate`: style and subject prompts required, each via inline (`--style` / `--subject`) or from a file (`--style-file` / `--subject-file`, UTF-8, `.trim()`-applied, mutually exclusive with the inline form).
  - `edit`: at least one `--reference <path>` (repeatable) plus an instruction via `--instruction` or `--instruction-file`. References must point at existing files with extensions in `{png,jpg,jpeg,webp}`. Basename collisions auto-suffix; same-source dedup is silent-with-warning.
  - Common: `--generate`, `--select` optional with int validation; `--aspect` optional one-of (`square|portrait|landscape`, default `square`); `--name` optional slug (`[A-Za-z0-9._-]+`); `--out` optional dir (relative or absolute); `--debug` optional flag (preserves tmp on success). `-h`/`--help` prints usage to stdout and exits 0 (POSIX convention — pipeable). Usage-due-to-error (missing required arg, invalid number, invalid slug, invalid aspect, mutually-exclusive conflict, missing/empty/unreadable prompt file, unknown @-token, bad reference) prints to stderr and exits 2.
- **`@`-token grammar (edit mode):** capture regex `/@([A-Za-z0-9._-]*[A-Za-z0-9_-])/g` (last char must be non-dot so trailing prose punctuation isn't sucked into the token); per-token substitution regex `@<escaped>(?![A-Za-z0-9_-])` (boundary excludes dot so the substitution fires when followed by sentence punctuation). Substitution is applied longest-token-first to disambiguate when both `@cat` and `@cat.png` are staged.
- **Output contract:** JSON on stdout via `emit()`. Always the same shape: `ok`, `mode`, `generated.{count,paths}`, `selected.{count,paths,expected}`, `outputDir`, `workdir`, `aspect.{name,width,height}`, `warnings`, `durationMs`. Edit mode adds `references[]` and `instruction.{raw,resolved}`. Exit code 0 iff `ok`.
- **Error model:** all failure paths route through `emit(..., 1)` with a populated `error` or non-empty `warnings`. No partial JSON, no half-written stdout.
- **Path style:** prompts to codex use posix-slash absolute paths (`replace(/\\/g,'/')`); fs operations use `path.join` natively.
- **Image discovery:** `listImages(dir)` filters by `\.(png|jpe?g|webp)$/i`, sorts by mtime ascending (filename tiebreaker so equal-mtime files sort deterministically — matters under FAT32's 2s resolution and on fast in-same-ms generation). Non-recursive — subdirs (`references/`, `selected/`) are filtered out, which is what we want so reference files aren't miscounted as generated outputs. Fallback to `~/.codex/generated_images/` only if requested dir is empty (with warning).
- **Session dir naming:** `<timestamp>-<pid>` under `<cwd>/.codex-image-gen-tmp/` (interim). Copied finals go to `resolve(cwd, --out || 'codex-image-gen-output')` (persistent). Default filename: `<sessionId>-<basename>`. With `--name`: `<slug><ext>` for select=1, `<slug>-<n><ext>` for select>1; collisions (existing file at preferred dest) fall back to `<slug>-<sessionId>[.|-<n>]<ext>` with a warning. Caller adds the persistent dir + `.codex-image-gen-tmp/` to their `.gitignore` (this repo's .gitignore covers the defaults).
- **Edit-mode reference staging:** `<sessionDir>/output/references/<basename>` — copy each `--reference` into a subdir of the codex `--cd` target. Subdir keeps reference files out of the generated-output scan. Cleaned up with the rest of tmp on success.
- **Cleanup contract:** on `ok && !--debug`, the session tmp dir is removed via `rmSync(sessionDir, {recursive:true, force:true})`. Failures (`ok===false`) preserve tmp unconditionally for debugging. Cleanup errors emit a warning but do not flip `ok` to false.
- **Settings patcher (`install.mjs`):** idempotent — re-runs are no-ops; tolerates missing/malformed settings.json by printing the rule instead of crashing. Per-target — currently only the Claude target needs it (opencode, Cline, and Cursor are permissive by default).
- **Multi-target install (`install.mjs`):** owns a `TARGETS` registry (`{id, label, skillDir, settingsPath, detectPath, defaultOn, explicitOnly?}`). Resolution: `--target=<csv>` overrides everything; else `--all` selects every target (including `explicitOnly` ones); else default = every target where `!explicitOnly && (defaultOn || detectPath exists)`; `--no-<id>` removes from the resulting set. `--list-targets` prints state and exits. To add a new harness, append a registry entry plus a test case in `tests/install.test.mjs`. AGENTS.md-only harnesses (Aider, Continue.dev, Windsurf, etc.) are intentionally not auto-registered — their right channel is a project-root file the user shouldn't have auto-modified. The `agents` cross-harness target uses `explicitOnly: true` to avoid duplicate-skill issues with Cursor/opencode, which read both `~/.agents/skills/` and their own per-harness path.

## Repo files (entry points)
- `codex-image-gen.mjs` — runtime tool (executable, shebang `node`).
- `install.mjs` — installer (executable, shebang `node`).
- `SKILL.md` — Claude Code skill template with `<<INSTALL_PATH>>` / `<<SCRIPT_PATH>>` placeholders.
- `README.md` — user-facing docs.
- `AGENTS.md` / `CLAUDE.md` — agent-facing instructions; CLAUDE.md is a one-line `@AGENTS.md` re-export.
- `.gitignore` — pre-includes `.codex-image-gen-tmp/`.
- `LICENSE` — MIT.
