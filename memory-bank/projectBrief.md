# projectBrief

## Purpose
Portable Node CLI tool that lets Claude Code (or any agent) generate or edit raster PNG images by shelling out to OpenAI's `codex` CLI. Routes billing through the user's ChatGPT subscription instead of API tokens.

## Scope
- One ESM entry point: `codex-image-gen.mjs`.
- Two subcommands:
  - `generate` (default — keyword may be omitted) synthesizes a new image from `--style` + `--subject`.
  - `edit` modifies or combines reference image(s) per a free-form `--instruction` whose `@<basename>` tokens resolve to staged paths.
- Cross-platform installer: `install.mjs`. Copies tool to `~/.codex-image-gen/` and Claude Code skill to `~/.claude/skills/codex-image-gen/SKILL.md`.
- Skill template: `SKILL.md` (placeholders `<<INSTALL_PATH>>` / `<<SCRIPT_PATH>>` rendered at install).
- Zero npm dependencies. Node 18+ only.
- Serial-by-design (no concurrent invocation).
- Two-dir output layout per cwd: `./.codex-image-gen-tmp/<sessionId>/` (interim, auto-cleaned on success) + `./codex-image-gen-output/` (persistent finals, sessionId-prefixed filenames). Persistent dir is overridable via `--out`; filenames are slug-based with `--name`.

## Out of scope
- SVG / vector output.
- Pixel-perfect image edits (resize, recolor, crop). `edit` mode is generative — for deterministic transforms, use a dedicated image library.
- Concurrent / parallel invocation.
- Bundling, transpiling, or any build step.

## Requirements
- Must NOT use `OPENAI_API_KEY` — deletes it from spawned env so codex routes to ChatGPT subscription billing.
- Must NOT override `CODEX_HOME` — codex stores ChatGPT auth there.
- Must work on Windows + macOS + Linux. Windows requires `shell:true` for spawning `codex.cmd`.
- Must keep zero-dep, single-file properties when changes are proposed.

## Distribution
GitHub: https://github.com/NicholasMTElliott/codex-image-gen — MIT licensed.
