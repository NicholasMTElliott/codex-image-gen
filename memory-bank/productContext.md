# productContext

## Problem
Claude Code cannot generate raster images natively. Calling OpenAI image APIs directly burns API tokens. Many users have a ChatGPT Plus/Pro subscription whose image quota would otherwise go unused.

## Solution
Wrap `codex exec --full-auto` so an agent can request N variants and optionally have codex review and pick the best M. Billing flows through the ChatGPT subscription as long as `OPENAI_API_KEY` is unset in the spawned env.

## Functional intent

### Subcommands
- `generate` (default; keyword may be omitted for backward compat with 0.2.x callers) — synthesize a brand-new image from prompts.
- `edit` — modify or combine reference images per a free-form instruction. The discovery that enabled this: `codex exec`'s built-in `image_gen` tool can read PNGs that live inside its working directory, even though `codex exec -i <path>` does not reliably surface external files. The tool stages each `--reference` into the per-session sandbox at `references/<basename>` so codex can read them.

### `generate` mode inputs
- `--style` / `--style-file` (visual treatment, inline or from file), `--subject` / `--subject-file` (what to depict, inline or from file). The `*-file` variants are mutually exclusive with their inline counterparts; useful for long multi-line briefs that don't shell-escape cleanly.
- `--aspect` (default `square`) — picks one of gpt-image-2's three supported sizes: `square` (1024×1024), `portrait` (1024×1536), `landscape` (1536×1024). The keyword + pixel target are pasted into the codex prompt so the request routes to the right size; surfaced in the JSON output as `aspect: { name, width, height }`. Same flag works in `edit` mode.

### `edit` mode inputs
- `--reference <path>` (required, repeatable) — paths to reference images (.png/.jpg/.jpeg/.webp). Each is staged into `<sessionDir>/output/references/<basename>`. Basename collisions auto-suffix to `-2`, `-3`, … and warn. Duplicate paths dedup silently with a warning.
- `--instruction` / `--instruction-file` — free-form text. Refer to staged files via `@<staged-basename>` (e.g. `@alien.png`). The `@`-tokens are validated up-front against the staged set; unknown tokens (typos like `@alient.png`) exit 2 with the available mapping printed before spawning codex. After validation, each `@<basename>` is substituted with `references/<basename>` in the prompt sent to codex. Substitution is longest-token-first so `@cat.png` resolves before a bare `@cat`. References passed but never `@`-mentioned trigger an "unreferenced" warning.

### Common inputs (both modes)
- `--generate N` (default 1), `--select M` (default 1, ≤ N), `--name SLUG` (optional, output filename slug), `--out DIR` (optional, persistent output dir override), `--debug` (flag, default off).

### Shared behavior
- Behavior: spawns codex with a synthesized prompt, waits, scans tmp dir, copies selected files to a persistent output dir, cleans up tmp on success.
- Selection: when `select < generate`, codex reviews variants and copies chosen ones into `output/selected/`. When `select == generate`, no review step.
- Persistence: selected files copied to `<persistentOutputDir>/<filename>`. Default dir is `<cwd>/codex-image-gen-output/` (override with `--out`, relative or absolute). Default filename is `<sessionId>-<basename>` (sessionId prefix prevents cross-run collisions). With `--name SLUG`, filename is `<slug>.png` when select=1 or `<slug>-<n>.png` when select>1; on collision with an existing file, falls back to `<slug>-<sessionId>[.|-<n>].png` and warns (preserves prior keepers).
- Cleanup: tmp session dir (`./.codex-image-gen-tmp/<sessionId>/`) removed on success unless `--debug`. Failures preserve tmp regardless.
- Output: machine-readable JSON on stdout — `ok`, `mode` (`"generate"` or `"edit"`), `generated.{count,paths}`, `selected.{count,paths,expected}`, `outputDir`, `workdir`, `aspect.{name,width,height}`, `warnings`, `durationMs`. `edit` mode adds `references[]` (each `{source,staged,referenced}`) and `instruction.{raw,resolved}`. After cleanup `generated.paths` is empty (would be stale tmp paths); `selected.paths` always points to the persistent output dir.

## UX expectations
- Two cwd-relative dirs by default: `./.codex-image-gen-tmp/<sessionId>/` (interim, auto-deleted on success) and `./codex-image-gen-output/` (persistent finals, accumulates across runs — override with `--out`). Caller is responsible for moving keepers out (unless `--out` already points at the asset folder) and adding both to `.gitignore`.
- ~30-60s per variant; ~5-6 min for a 4-generate / 2-select run.
- Image quota burns 3-5x faster than text turns (5-hour rolling cap + weekly cap). Plus is tight for ~20-image batches; Pro recommended.
- Warnings (non-empty `warnings` with `ok: true`) signal partial-success fallbacks fired (mtime image discovery, mtime selection, copy/cleanup failures) — worth re-running.
- `ok: false` + no `error` → codex produced fewer images than requested; tmp preserved for inspection; re-run.
