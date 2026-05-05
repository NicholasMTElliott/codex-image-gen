# projectBrief

## Purpose
Portable Node CLI tool that lets Claude Code, opencode, Cline, Cursor, or any other coding-agent harness generate or edit raster PNG images by shelling out to OpenAI's `codex` CLI. Routes billing through the user's ChatGPT subscription instead of API tokens.

## Scope
- One ESM entry point: `codex-image-gen.mjs`.
- Two subcommands:
  - `generate` (default — keyword may be omitted) synthesizes a new image from `--style` + `--subject`.
  - `edit` modifies or combines reference image(s) per a free-form `--instruction` whose `@<basename>` tokens resolve to staged paths.
- Cross-platform installer: `install.mjs`. Copies tool to `~/.codex-image-gen/` and registers the rendered SKILL.md with each detected coding-agent harness via a `TARGETS` registry. Current targets: **Claude Code** (`~/.claude/skills/codex-image-gen/SKILL.md` + `permissions.allow` patch in `~/.claude/settings.json`), **opencode** (`~/.config/opencode/skills/codex-image-gen/SKILL.md`; no settings patch — opencode is permissive by default), **Cline** (`~/.cline/skills/codex-image-gen/SKILL.md`; uses Cline's user-global Skills system), **Cursor** (`~/.cursor/skills/codex-image-gen/SKILL.md`; uses Cursor's Skills system), and **agents** (`~/.agents/skills/codex-image-gen/SKILL.md`; cross-harness shared dir read by Cursor + opencode — `explicitOnly: true`, never auto-installed even when its detect path exists). Flags: `--target=<csv>` / `--all` / `--no-<id>` / `--list-targets` / `--uninstall`. Adding a harness = one entry in the `TARGETS` array plus a test case.
- Skill template: `SKILL.md` (Anthropic-style frontmatter — `name` + `description` + `allowed-tools`; placeholders `<<INSTALL_PATH>>` / `<<SCRIPT_PATH>>` rendered at install). Same rendered file is dropped into every target's skills dir; harnesses that don't recognize a field silently ignore it.
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
