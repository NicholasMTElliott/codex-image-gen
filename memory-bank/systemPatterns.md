# systemPatterns

## Architecture
Single-process Node ESM script. No daemon, no state, no IPC beyond the spawned codex child. Two subcommands share the spawn → scan → copy → cleanup pipeline; only the prompt synthesis (and, in edit mode, an additional reference-staging step) differ.

```
caller (Claude Code / shell)
   │  generate: --style[-file] / --subject[-file] / --generate / --select / --name / --out
   │  edit:     --reference (xN) / --instruction[-file] / --generate / --select / --name / --out
   ▼
codex-image-gen.mjs
   │  parseArgs → subcommand dispatch (generate | edit; default generate)
   │  edit only: planStaging → resolveInstructionTokens (validate @-tokens up-front,
   │             exit 2 on typo) → stageReferences (copyFileSync each ref into
   │             <sessionDir>/output/references/<basename>)
   │  buildPrompt (mode-specific) → spawn:
   │  spawn('codex', ['exec','--full-auto','--skip-git-repo-check','--cd', tmpOutDir]),
   │     env without OPENAI_API_KEY, prompt via stdin
   ▼
codex CLI (ChatGPT-authed)
   │  built-in image_gen tool → PNGs into tmpOutDir,
   │  edit mode: also reads from tmpOutDir/references/<basename>
   │  optional review → copies winners to tmpOutDir/selected/
   ▼
listImages → copyFileSync into <persistentOutputDir>/<destName>
   │    persistentOutputDir = resolve(cwd, --out || 'codex-image-gen-output')
   │    destName            = '<sessionId>-<basename>'  (default)
   │                        | '<slug>[.|-N]<ext>'        (with --name; collision
   │                                                     fallback adds sessionId)
   │  rmSync(<cwd>/.codex-image-gen-tmp/<sessionId>/) unless --debug or !ok
   ▼
JSON to stdout (selected.paths in persistent dir, generated.paths [] after cleanup;
edit mode adds references[] and instruction.{raw,resolved})
```

## Major design choices
- **No npm deps.** Trivial install, no node_modules, no supply chain.
- **Subcommand dispatch with backward-compat default.** First positional arg (no leading `-`) selects mode (`generate` | `edit`). Absent or flag-first → defaults to `generate` so 0.2.x flag-only invocations keep working. Per-mode arg parsers reject the *other* mode's exclusive flags with a "unknown argument X for Y mode" error.
- **Strip `OPENAI_API_KEY`** from spawned env. If codex sees it, it silently switches to API billing.
- **Do not override `CODEX_HOME`.** Codex stores ChatGPT auth there; overriding → fresh-install state → 401. Codex#11435 parallel-corruption only matters concurrently; this tool is serial-by-design.
- **Prompt via stdin, not argv.** On Windows `shell:true` is required to spawn `codex.cmd` (post-CVE-2024-27980), but Node concatenates args without escaping under `shell:true`, so multi-word prompts split. Stdin sidesteps this.
- **`--cd` to session output dir.** Confines codex's `workspace-write` sandbox to that directory.
- **`--full-auto`.** Skips per-shell-command approval prompts so the workflow is hands-off.
- **`--skip-git-repo-check`.** The `--cd` target is always a fresh per-session tmp dir, never a git repo, so codex's trusted-dir guard would refuse every run otherwise. Safe because the prompt only asks codex to generate images and copy them inside that same dir — no destructive operations elsewhere.
- **Posix-style path inside the prompt** (`replace(/\\/g, '/')`) — codex normalizes both, but forward slashes avoid backslash-escape ambiguity in tool-call parsing.
- **mtime-sorted image listing** with fallbacks for both image-discovery and selection: if codex didn't write to the requested dir, look in `~/.codex/generated_images/`; if codex didn't produce a `selected/` subfolder, take first M generated images by mtime. Each fallback emits a warning.
- **Two-dir output layout.** Codex writes into `<cwd>/.codex-image-gen-tmp/<sessionId>/output/` (interim sandbox); selected files are then copied into the persistent output dir (default `<cwd>/codex-image-gen-output/`, override via `--out`). This separates short-lived work from artifacts the caller actually wants, lets us reclaim tmp disk on success, and (with the default sessionId-prefixed filenames) namespaces filenames so consecutive runs don't clobber each other. Default persistent dir name is tool-namespaced (`codex-image-gen-output`, not `output`) to avoid collision with build-tool conventions in the caller's repo.
- **Filename strategy.** Default: `<sessionId>-<basename>` — collision-safe across runs but requires renaming when moving to a final asset path. With `--name <slug>`: `<slug><ext>` when `select=1`, `<slug>-<n><ext>` when `select>1` — no rename needed. On collision (re-run with same `--name` + same dir), falls back to a sessionId-disambiguated form (`<slug>-<sessionId>[.|-<n>]<ext>`) and emits a warning so prior keepers stay intact. Slug is restricted to `[A-Za-z0-9._-]+` to block path traversal and shell metachars at the boundary; users wanting arbitrary destinations should use `--out` for the dir part instead.
- **Cleanup-on-success default.** On `ok && !--debug`, `rmSync(sessionDir, {recursive:true, force:true})` runs before emit. Failed runs (`ok===false`) preserve tmp unconditionally so the user can investigate. Cleanup failures are non-fatal — recorded as a warning, the run still reports `ok:true`.
- **Stale-path elision.** After cleanup, the JSON's `generated.paths` is `[]` rather than the tmp paths that no longer exist. `generated.count` still reports what codex produced. `selected.paths` always points to the surviving persistent copies.

### Aspect-ratio handling (generate / edit)
- **`ASPECT_DIMENSIONS` constant** maps `square|portrait|landscape` → `{w,h}` pairs (the only three sizes `gpt-image-2` supports). `--aspect` defaults to `square` so existing 0.3.x callers keep working unchanged.
- **Prompt phrasing:** `"Render the image in <aspect> aspect ratio (<W>x<H> pixels)."` is inserted as the second line of both generate and edit prompts (right under the "use image_gen" line, above the brief). Phrasing is verbose-by-design — codex routes to the right size more reliably when both the keyword *and* the pixel target are present.
- **JSON surface:** `aspect: { name, width, height }` block in the result. Lets callers re-derive the size without re-parsing the prompt and provides an audit trail for the chosen size.

### Edit-mode-specific design choices
- **Stage references via copy, not `codex exec -i`.** Empirical finding: codex's `image_gen` tool reads files inside its working directory, but the `-i path/to/file` flag does not reliably surface external files into that workspace. Copying each `--reference` into `<sessionDir>/output/references/<basename>` is portable across operating systems (no Windows symlink-permission issues, no same-filesystem constraint of hardlinks) and the disk overhead is trivial since references are deleted with the rest of tmp on success.
- **References staged into a `references/` subdir, not the cd root.** `listImages(<tmpOutputDir>)` is non-recursive and only counts files in the cd root — the subdir keeps reference files from being miscounted as generated outputs. Codex's own outputs land at `<tmpOutputDir>/variant-N.png` and the (optional) `<tmpOutputDir>/selected/` subfolder, alongside `<tmpOutputDir>/references/`.
- **`@<staged-basename>` token grammar in `--instruction`.** Capture regex `/@([A-Za-z0-9._-]*[A-Za-z0-9_-])/g` — the trailing-non-dot constraint stops sentence-ending periods (`@pose.png.`) from being sucked into the token. Substitution regex `@<escaped>(?![A-Za-z0-9_-])` — boundary excludes `.` so `@pose.png.` substitutes correctly when followed by sentence punctuation. Substitution is applied longest-token-first to disambiguate when both `@cat` and `@cat.png` are staged.
- **Up-front token validation.** Every `@`-token must resolve to a staged basename, otherwise exit 2 with the unknown-token list and the full staged mapping printed — this catches typos like `@alient.png` *before* burning a codex call. References passed via `--reference` but never `@`-mentioned are warned, not errored — codex may still pull from them in unintended ways.
- **Auto-suffix on basename collision.** When two `--reference` paths share a basename, the second is renamed (`cat.png` + `cat-2.png`) and a warning is emitted that includes the staged name so the user can update their `--instruction`. Validation surfaces the mapping early so the user can correct without burning quota. Same-source dedup happens silently (with a warning), since duplicate paths are almost certainly user error rather than intent.
- **`mode` field added to JSON output for both modes.** Edit mode additionally surfaces `references[]` (each `{source,staged,referenced}`) and `instruction.{raw,resolved}` so callers can see exactly what codex was asked to do after substitution.

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

### Generate mode
1. Parse args; resolve `--style-file`/`--subject-file` (mutually exclusive with their inline counterparts; UTF-8 read, `.trim()` to strip trailing newline, empty-after-trim is rejected); validate `select ≤ generate`, both positive integers; `--name` slug (if present) matches `[A-Za-z0-9._-]+`. `--debug` parsed as flag.
2. Make `<cwd>/.codex-image-gen-tmp/<timestamp>-<pid>/output/` (the per-session tmp work dir).
3. Build prompt: instructs codex to write exactly N PNGs into that absolute dir, and (if `select<generate`) copy M chosen files into `selected/`. Uses posix-slash absolute paths.
4. Spawn `codex exec --full-auto --skip-git-repo-check --cd <tmpOutputDir>` with `OPENAI_API_KEY` deleted from env. Pipe prompt via stdin.
5. On spawn failure or non-zero exit → emit `ok:false` JSON with stderr tail. Tmp preserved.
6. On zero exit: scan tmp output dir for images; if empty, fall back to `~/.codex/generated_images/` (warn).
7. If `select<generate`: scan `<tmp>/output/selected/`; if empty, take first M of generated by mtime (warn). Else: selected = first M of generated.
8. Resolve `persistentOutputDir = resolve(cwd, --out || 'codex-image-gen-output')`. Copy each selected file there using the filename strategy above (default `<sessionId>-<basename>`; with `--name`, slug-based with collision fallback). Copy failures are recorded as warnings.
9. `ok = (generated.length == --generate) && (persistentSelected.length == --select)`.
10. If `ok && !--debug`: `rmSync(sessionDir)` (best-effort; failure → warning). Else preserve tmp.
11. Emit JSON: `mode: "generate"`; `selected.paths` = persistent paths; `generated.paths` = [] if cleaned up else tmp paths; `outputDir` = persistent dir; `workdir` = tmp session dir (may not exist after cleanup). Exit 0 if ok else 1.

### Edit mode
1. Parse args (per-mode). At least one `--reference` and one of `--instruction`/`--instruction-file` required; rejects `--style`/`--subject` with a helpful "unknown argument for edit mode" error. Common-arg validation (generate, select, name) shared with generate mode.
2. `planStaging(references)` — pure pass: resolve each path, validate exists+isFile+image-extension, dedup by absolute source, allocate staged basenames (auto-suffix on collision). Returns `entries[]` and `warnings[]`. Fails fast with exit 2 on bad paths *before* mkdir'ing anything.
3. `resolveInstructionTokens(instruction, entries)` — extract every `@<token>` via regex; each must hit a staged basename. Unknown token → exit 2 with the available mapping printed. Marks `entry.referenced=true` for hits. Then substitutes `@<basename>` → `references/<basename>` longest-first. Returns the resolved string.
4. Warn for any `entry.referenced===false` (passed but never `@`-mentioned).
5. Make `<cwd>/.codex-image-gen-tmp/<timestamp>-<pid>/output/` and `<cwd>/.codex-image-gen-tmp/<timestamp>-<pid>/output/references/`. `copyFileSync` each entry's source into the staged path.
6. Build edit-mode prompt: "Reference images available… Instructions: <resolved>… Generate N PNGs into <outputDir>… Do not modify or duplicate files under references/." Posix-slash paths.
7. Steps 4–11 from generate mode flow above (spawn → scan → select → copy → cleanup → emit). Result JSON additionally has `mode:"edit"`, `references[]`, `instruction.{raw,resolved}`.

## Invariants
- A single run is always serial. Never spawn multiple codex children in parallel.
- Session dirs are unique per invocation: `<timestamp>-<pid>`.
- Output JSON is always valid — even on failure paths, `emit()` writes the same shape.
