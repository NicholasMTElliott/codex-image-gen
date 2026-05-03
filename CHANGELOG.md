# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `edit` subcommand modifies or combines reference image(s) per a free-form
  `--instruction`. Pass one or more `--reference <path>` flags; each is staged
  into the per-session sandbox at `references/<basename>` so codex can read it.
  Reference files in the instruction text via `@<staged-basename>` (e.g.
  `"Render @alien.png in the pose of @pose.png"`); tokens are validated up-front
  and substituted with the staged path before the prompt is sent. Typo'd tokens
  exit 2 with the available mapping printed before any codex call. Basename
  collisions auto-suffix to `-2`, `-3`, … with a warning; duplicate paths
  dedup silently. References passed but never `@`-mentioned trigger an
  "unreferenced" warning. `--instruction-file` provides the same text-from-file
  ergonomics as `--style-file` / `--subject-file`.
- `mode` field added to JSON output for both subcommands (`"generate"` or
  `"edit"`). `edit` mode additionally surfaces `references[]` (each with
  `{source, staged, referenced}`) and `instruction.{raw, resolved}` so callers
  can inspect exactly what codex was asked to do.
- `generate` keyword as an explicit subcommand (still the default; flag-only
  invocations from 0.2.x continue to work unchanged).
- Live-smoke coverage for edit mode (gated on `TEST_LIVE=1`).

### Changed
- The single-file runtime grew to accommodate the edit subcommand. Both
  subcommands share spawn / scan / copy / cleanup; only prompt synthesis and
  (in edit mode) reference staging differ.
- Per-mode arg parsing now rejects unknown flags with a clear "unknown
  argument X for Y mode" error instead of silently ignoring them. This is a
  minor behavior change from 0.2.x which silently ignored typos; intent is
  to surface mistakes early. Pass `--help` to see the current per-mode flag
  set.

## [0.2.0] - 2026-05-02

### Added
- `--name <slug>` flag controls the persistent output filename. With
  `--select 1`, the file is named `<slug>.png`; with `--select 2+`, files are
  numbered `<slug>-1.png`, `<slug>-2.png`, …. Eliminates the manual rename when
  moving keepers into the project. Slug is restricted to `[A-Za-z0-9._-]+` to
  block path-traversal and shell-meta surprises at the boundary. On a re-run
  collision, falls back to a sessionId-disambiguated name (`<slug>-<sessionId>
  [.|-<n>].png`) and emits a warning so prior keepers stay intact.
- `--out <dir>` flag overrides the persistent output directory (relative to
  cwd, or absolute). Pair with `--name` to drop selected images straight into
  a project's asset folder, e.g. `--out assets/icons --name kharr-emblem`.
  Defaults to `./codex-image-gen-output/` (unchanged).
- `--style-file <path>` and `--subject-file <path>` flags read the style /
  subject prompt from a UTF-8 text file. Useful for long, multi-line briefs
  (e.g. a coherent style guide reused across an asset family) that don't
  shell-escape cleanly under PowerShell or bash. Mutually exclusive with the
  inline `--style` / `--subject`. File contents are trimmed of leading and
  trailing whitespace; internal newlines are preserved. Empty / whitespace-only
  files are rejected with a clear error rather than producing a degenerate run.

### Changed
- CI matrix bumped to `actions/checkout@v6` and `actions/setup-node@v6`
  (Node 24 GitHub-Actions runtime).

## [0.1.1] - 2026-05-02

### Fixed
- Test helper `mktempDir` now resolves via `realpathSync` so path-equality
  assertions work on macOS, where `/var` is a symlink to `/private/var` and
  the spawned tool's `process.cwd()` reports the canonicalised form.

## [0.1.0] - 2026-05-02

### Added
- Initial release. Single-file Node ESM CLI (`codex-image-gen.mjs`) that
  shells out to OpenAI's `codex` CLI to generate raster images using the
  user's ChatGPT subscription billing rather than API tokens. Strips
  `OPENAI_API_KEY` from the spawned env to lock in subscription routing.
  Supports `--style`, `--subject`, `--generate N`, `--select M`, and `--debug`.
  Two-dir output layout per cwd: `./.codex-image-gen-tmp/<sessionId>/` for
  interim work (auto-cleaned on success) and `./codex-image-gen-output/` for
  persistent finals (sessionId-prefixed filenames, accumulates across runs).
- Cross-platform installer (`install.mjs`) that copies the tool to
  `~/.codex-image-gen/`, renders and installs a Claude Code skill at
  `~/.claude/skills/codex-image-gen/SKILL.md`, and idempotently patches
  `~/.claude/settings.json` `permissions.allow`.
- Zero npm dependencies; Node 18+.

[0.2.0]: https://github.com/NicholasMTElliott/codex-image-gen/compare/release/v0.1.1...release/v0.2.0
[0.1.1]: https://github.com/NicholasMTElliott/codex-image-gen/compare/release/v0.1.0...release/v0.1.1
[0.1.0]: https://github.com/NicholasMTElliott/codex-image-gen/releases/tag/release/v0.1.0
