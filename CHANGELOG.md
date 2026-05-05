# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-05-05

### Added
- `--aspect square|portrait|landscape` flag for `generate` and `edit` modes
  (default `square`). Maps 1:1 to gpt-image-2's only supported sizes
  (1024×1024, 1024×1536, 1536×1024); the keyword and pixel target are
  pasted into the codex prompt so the request routes to the right size,
  and the chosen aspect surfaces in JSON output as `aspect: { name,
  width, height }`.
- Multi-target install. The installer now owns a `TARGETS` registry and drops
  the rendered SKILL.md into every supported coding-agent harness's
  user-global skills dir, not just Claude Code. Adding a new harness is one
  registry entry plus a test case. Current targets:
  - `claude` — `~/.claude/skills/codex-image-gen/SKILL.md` + `permissions.allow`
    patch in `~/.claude/settings.json` (default-on; preserves historical
    behaviour).
  - `opencode` — `~/.config/opencode/skills/codex-image-gen/SKILL.md`
    (auto-detected via `~/.config/opencode/`; opencode is permissive by default,
    no settings patch).
  - `cline` — `~/.cline/skills/codex-image-gen/SKILL.md` (auto-detected via
    `~/.cline/`; uses Cline's user-global Skills system, no allowlist needed).
  - `cursor` — `~/.cursor/skills/codex-image-gen/SKILL.md` (auto-detected via
    `~/.cursor/`; Cursor reads its own dir plus compatibility paths
    `~/.claude/skills/` and `~/.codex/skills/`).
  - `agents` — `~/.agents/skills/codex-image-gen/SKILL.md`. Cross-harness
    shared dir read by Cursor + opencode. **Explicit-only** (`--target=agents`
    or `--all`) — never auto-installed even when `~/.agents/` exists, since
    that would duplicate the per-harness installs in harnesses that read both
    paths.
- Installer flags: `--target=<csv>` (explicit list, overrides detection),
  `--all` (every known target including explicit-only), `--no-<id>` (exclude
  from default set), `--list-targets` (show registry + detection state and
  exit). `--uninstall` now removes every known target's skill dir.
- Phase-numbered progress output during install (`[1/4] Pre-flight`,
  `[2/4] Resolve install targets`, `[3/4] Copy runtime tool`, `[4/4] Install
  skill into target harnesses`). Pre-flight surfaces resolved `node` and
  `codex` versions in the log so support requests can include them without
  follow-up prompts. Per-target line shows why each target was included
  (`detected` / `default-on` / `forced`).
- Duplicate-warning during install when both the `agents` target and a
  per-harness target that reads `~/.agents/skills/` are selected together
  (`cursor`, `opencode`). Tells the user the skill will appear twice in those
  harnesses' lists and suggests the `--no-<id>` flag to dedupe.

### Changed
- Installer: pre-flight checks (`node`, `codex`, `SKILL.md` template,
  `codex-image-gen.mjs` runtime) now run before *any* filesystem mutation.
  Previous order created `~/.codex-image-gen/` and copied the binary before
  noticing a missing template, leaving a half-installed state on a broken
  checkout. Pre-flight failures exit 1 with no side effects.
- Installer: error/warning output is split between stderr (errors via
  `ERROR:` prefix; advisory warnings unprefixed) and stdout (normal progress
  + post-failure manual-fix instructions). Multi-line guidance no longer
  repeats the `ERROR:` prefix on every line.
- Installer: unexpected exceptions (e.g., a `mkdirSync` failure on a
  permission issue) are caught at the top level and surfaced as a one-line
  friendly error. Set `CIG_INSTALL_DEBUG=1` to see the full stack trace.
- README and memory-bank docs reflect multi-target install behaviour.

### Fixed
- Installer: SKILL.md template rendering used `String.replace` with a string
  replacement, which interprets `$&` / `$1` / `$$` as backreferences. If the
  resolved install path ever contained a literal `$` (legal in Windows
  usernames — service accounts often end in `$`), the rendered skill would
  silently mangle. Now uses the function form of `replace` and verifies no
  `<<…>>` placeholders remain in the rendered output before writing.
- Installer: `--no-<id>` with a typo'd id (e.g. `--no-claud`) was silently
  added to the exclusion set and matched no target — the user thought they
  had excluded a target but the installer proceeded as if no `--no-` was
  passed. Now validates `--no-<id>` against the known target ids and exits
  2 with a clear error on unknown ids. Same validation applies to comma-
  separated entries inside `--target=<csv>` and to empty `--target=`.
- Installer: `patchSettings` write failures (typically an exclusive write
  lock on Windows when Claude Code is running and holds `settings.json`)
  no longer propagate as raw stack traces. They emit a clear `[skip]`
  message naming the cause and prompting the user to quit Claude Code or
  add the rule manually.

## [0.3.0] - 2026-05-03

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

[0.4.0]: https://github.com/NicholasMTElliott/codex-image-gen/compare/release/v0.3.0...release/v0.4.0
[0.3.0]: https://github.com/NicholasMTElliott/codex-image-gen/compare/release/v0.2.0...release/v0.3.0
[0.2.0]: https://github.com/NicholasMTElliott/codex-image-gen/compare/release/v0.1.1...release/v0.2.0
[0.1.1]: https://github.com/NicholasMTElliott/codex-image-gen/compare/release/v0.1.0...release/v0.1.1
[0.1.0]: https://github.com/NicholasMTElliott/codex-image-gen/releases/tag/release/v0.1.0
