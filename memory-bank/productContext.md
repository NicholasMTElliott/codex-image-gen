# productContext

## Problem
Claude Code cannot generate raster images natively. Calling OpenAI image APIs directly burns API tokens. Many users have a ChatGPT Plus/Pro subscription whose image quota would otherwise go unused.

## Solution
Wrap `codex exec --full-auto` so an agent can request N variants and optionally have codex review and pick the best M. Billing flows through the ChatGPT subscription as long as `OPENAI_API_KEY` is unset in the spawned env.

## Functional intent
- Inputs: `--style` (visual treatment), `--subject` (what to depict), `--generate N` (default 1), `--select M` (default 1, ≤ N), `--debug` (flag, default off).
- Behavior: spawns codex with a synthesized prompt, waits, scans tmp dir, copies selected files to a persistent output dir, cleans up tmp on success.
- Selection: when `select < generate`, codex reviews variants and copies chosen ones into `output/selected/`. When `select == generate`, no review step.
- Persistence: selected files copied to `<cwd>/codex-image-gen-output/<sessionId>-<filename>`. The sessionId prefix prevents collisions across consecutive runs in the same cwd.
- Cleanup: tmp session dir (`./.codex-image-gen-tmp/<sessionId>/`) removed on success unless `--debug`. Failures preserve tmp regardless.
- Output: machine-readable JSON on stdout — `ok`, `generated.{count,paths}`, `selected.{count,paths,expected}`, `outputDir`, `workdir`, `warnings`, `durationMs`. After cleanup `generated.paths` is empty (would be stale tmp paths); `selected.paths` always points to the persistent output dir.

## UX expectations
- Two cwd-relative dirs: `./.codex-image-gen-tmp/<sessionId>/` (interim, auto-deleted on success) and `./codex-image-gen-output/` (persistent finals, accumulates across runs). Caller is responsible for moving keepers out and adding both to `.gitignore`.
- ~30-60s per variant; ~5-6 min for a 4-generate / 2-select run.
- Image quota burns 3-5x faster than text turns (5-hour rolling cap + weekly cap). Plus is tight for ~20-image batches; Pro recommended.
- Warnings (non-empty `warnings` with `ok: true`) signal partial-success fallbacks fired (mtime image discovery, mtime selection, copy/cleanup failures) — worth re-running.
- `ok: false` + no `error` → codex produced fewer images than requested; tmp preserved for inspection; re-run.
