# productContext

## Problem
Claude Code cannot generate raster images natively. Calling OpenAI image APIs directly burns API tokens. Many users have a ChatGPT Plus/Pro subscription whose image quota would otherwise go unused.

## Solution
Wrap `codex exec --full-auto` so an agent can request N variants and optionally have codex review and pick the best M. Billing flows through the ChatGPT subscription as long as `OPENAI_API_KEY` is unset in the spawned env.

## Functional intent
- Inputs: `--style` (visual treatment), `--subject` (what to depict), `--generate N` (default 1), `--select M` (default 1, ≤ N).
- Behavior: spawns codex with a synthesized prompt, waits, scans output dir.
- Selection: when `select < generate`, codex reviews variants and copies chosen ones into `output/selected/`. When `select == generate`, no review step.
- Output: machine-readable JSON on stdout — `ok`, `generated.paths`, `selected.paths`, `workdir`, `warnings`, `durationMs`.

## UX expectations
- Caller-cwd-relative temp dir: `./.codex-image-gen-tmp/<sessionId>/output/`. Caller is responsible for moving final images out.
- ~30-60s per variant; ~5-6 min for a 4-generate / 2-select run.
- Image quota burns 3-5x faster than text turns (5-hour rolling cap + weekly cap). Plus is tight for ~20-image batches; Pro recommended.
- Warnings (non-empty `warnings` with `ok: true`) signal partial-success fallbacks fired — worth re-running.
- `ok: false` + no `error` → codex produced fewer images than requested; re-run.
