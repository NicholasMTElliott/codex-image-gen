# projectBrief

## Purpose
Portable Node CLI tool that lets Claude Code (or any agent) generate raster PNG images by shelling out to OpenAI's `codex` CLI. Routes billing through the user's ChatGPT subscription instead of API tokens.

## Scope
- One ~330-line ESM entry point: `codex-image-gen.mjs`.
- Cross-platform installer: `install.mjs`. Copies tool to `~/.codex-image-gen/` and Claude Code skill to `~/.claude/skills/codex-image-gen/SKILL.md`.
- Skill template: `SKILL.md` (placeholders `<<INSTALL_PATH>>` / `<<SCRIPT_PATH>>` rendered at install).
- Zero npm dependencies. Node 18+ only.
- Serial-by-design (no concurrent invocation).
- Two-dir output layout per cwd: `./.codex-image-gen-tmp/<sessionId>/` (interim, auto-cleaned on success) + `./codex-image-gen-output/` (persistent finals, sessionId-prefixed filenames).

## Out of scope
- SVG / vector output.
- Image editing (resize, recolor, crop). Generation only.
- Concurrent / parallel invocation.
- Bundling, transpiling, or any build step.

## Requirements
- Must NOT use `OPENAI_API_KEY` — deletes it from spawned env so codex routes to ChatGPT subscription billing.
- Must NOT override `CODEX_HOME` — codex stores ChatGPT auth there.
- Must work on Windows + macOS + Linux. Windows requires `shell:true` for spawning `codex.cmd`.
- Must keep zero-dep, single-file properties when changes are proposed.

## Distribution
GitHub: https://github.com/NicholasMTElliott/codex-image-gen — MIT licensed.
