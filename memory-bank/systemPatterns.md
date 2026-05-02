# systemPatterns

## Architecture
Single-process Node ESM script. No daemon, no state, no IPC beyond the spawned codex child.

```
caller (Claude Code / shell)
   │  --style / --subject / --generate / --select
   ▼
codex-image-gen.mjs
   │  spawn('codex', ['exec','--full-auto','--skip-git-repo-check','--cd', tmpOutDir]),
   │     env without OPENAI_API_KEY, prompt via stdin
   ▼
codex CLI (ChatGPT-authed)
   │  built-in image_gen tool → PNGs into tmpOutDir,
   │  optional review → copies winners to tmpOutDir/selected/
   ▼
listImages → copyFileSync into <cwd>/codex-image-gen-output/<sessionId>-<file>
   │  rmSync(<cwd>/.codex-image-gen-tmp/<sessionId>/) unless --debug or !ok
   ▼
JSON to stdout (selected.paths in persistent dir, generated.paths [] after cleanup)
```

## Major design choices
- **No npm deps.** Trivial install, no node_modules, no supply chain.
- **Strip `OPENAI_API_KEY`** from spawned env. If codex sees it, it silently switches to API billing.
- **Do not override `CODEX_HOME`.** Codex stores ChatGPT auth there; overriding → fresh-install state → 401. Codex#11435 parallel-corruption only matters concurrently; this tool is serial-by-design.
- **Prompt via stdin, not argv.** On Windows `shell:true` is required to spawn `codex.cmd` (post-CVE-2024-27980), but Node concatenates args without escaping under `shell:true`, so multi-word prompts split. Stdin sidesteps this.
- **`--cd` to session output dir.** Confines codex's `workspace-write` sandbox to that directory.
- **`--full-auto`.** Skips per-shell-command approval prompts so the workflow is hands-off.
- **`--skip-git-repo-check`.** The `--cd` target is always a fresh per-session tmp dir, never a git repo, so codex's trusted-dir guard would refuse every run otherwise. Safe because the prompt only asks codex to generate images and copy them inside that same dir — no destructive operations elsewhere.
- **Posix-style path inside the prompt** (`replace(/\\/g, '/')`) — codex normalizes both, but forward slashes avoid backslash-escape ambiguity in tool-call parsing.
- **mtime-sorted image listing** with fallbacks for both image-discovery and selection: if codex didn't write to the requested dir, look in `~/.codex/generated_images/`; if codex didn't produce a `selected/` subfolder, take first M generated images by mtime. Each fallback emits a warning.
- **Two-dir output layout.** Codex writes into `<cwd>/.codex-image-gen-tmp/<sessionId>/output/` (interim sandbox); selected files are then copied into `<cwd>/codex-image-gen-output/` (persistent flat dir, sessionId-prefixed filenames). This separates short-lived work from artifacts the caller actually wants, lets us reclaim tmp disk on success, and namespaces filenames so consecutive runs don't clobber each other. Persistent dir name is tool-namespaced (`codex-image-gen-output`, not `output`) to avoid collision with build-tool conventions in the caller's repo.
- **Cleanup-on-success default.** On `ok && !--debug`, `rmSync(sessionDir, {recursive:true, force:true})` runs before emit. Failed runs (`ok===false`) preserve tmp unconditionally so the user can investigate. Cleanup failures are non-fatal — recorded as a warning, the run still reports `ok:true`.
- **Stale-path elision.** After cleanup, the JSON's `generated.paths` is `[]` rather than the tmp paths that no longer exist. `generated.count` still reports what codex produced. `selected.paths` always points to the surviving persistent copies.

## Component relationships
- `codex-image-gen.mjs` — runtime. Pure: parse args → build prompt → spawn → scan → emit JSON.
- `install.mjs` — one-shot installer. Verifies `node` + `codex` on PATH, copies the tool, renders SKILL.md, idempotently patches `~/.claude/settings.json` `permissions.allow` with the `Bash(node <SCRIPT_PATH> *)` rule.
- `SKILL.md` — Claude Code skill template; tells the agent when to invoke and what arguments to pass. Two placeholders are rendered by the installer.

## Critical flows

### Install
1. Check `node --version` and `codex --version` succeed.
2. Copy `codex-image-gen.mjs` and `README.md` → `~/.codex-image-gen/`.
3. Render SKILL.md (replace `<<INSTALL_PATH>>` / `<<SCRIPT_PATH>>`) → `~/.claude/skills/codex-image-gen/SKILL.md`.
4. Patch `permissions.allow` in `~/.claude/settings.json` (idempotent; falls back to printing the rule if JSON is malformed).

### Generation
1. Parse args; validate `select ≤ generate`, both positive integers. `--debug` parsed as flag.
2. Make `<cwd>/.codex-image-gen-tmp/<timestamp>-<pid>/output/` (the per-session tmp work dir).
3. Build prompt: instructs codex to write exactly N PNGs into that absolute dir, and (if `select<generate`) copy M chosen files into `selected/`. Uses posix-slash absolute paths.
4. Spawn `codex exec --full-auto --skip-git-repo-check --cd <tmpOutputDir>` with `OPENAI_API_KEY` deleted from env. Pipe prompt via stdin.
5. On spawn failure or non-zero exit → emit `ok:false` JSON with stderr tail. Tmp preserved.
6. On zero exit: scan tmp output dir for images; if empty, fall back to `~/.codex/generated_images/` (warn).
7. If `select<generate`: scan `<tmp>/output/selected/`; if empty, take first M of generated by mtime (warn). Else: selected = first M of generated.
8. Copy each selected file to `<cwd>/codex-image-gen-output/<sessionId>-<basename>`. Copy failures are recorded as warnings.
9. `ok = (generated.length == --generate) && (persistentSelected.length == --select)`.
10. If `ok && !--debug`: `rmSync(sessionDir)` (best-effort; failure → warning). Else preserve tmp.
11. Emit JSON: `selected.paths` = persistent paths; `generated.paths` = [] if cleaned up else tmp paths; `outputDir` = persistent dir; `workdir` = tmp session dir (may not exist after cleanup). Exit 0 if ok else 1.

## Invariants
- A single run is always serial. Never spawn multiple codex children in parallel.
- Session dirs are unique per invocation: `<timestamp>-<pid>`.
- Output JSON is always valid — even on failure paths, `emit()` writes the same shape.
