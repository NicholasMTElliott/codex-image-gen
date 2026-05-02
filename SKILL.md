---
name: codex-image-gen
description: Generate raster/bitmap images (PNG) — icons, logos, faction emblems, illustrations, photos, textures, sprites, hero art, mockups — by shelling out to OpenAI's codex CLI. Uses the user's ChatGPT subscription billing (NOT API tokens). Invoke when the user asks for an image asset and Claude Code lacks a built-in image-generation tool. Do NOT use this skill for SVG/vector output, ASCII art, code that draws (Canvas/CSS/HTML), edits to existing images, or modifications of an established icon system in the repo.
allowed-tools:
  - Bash(node <<SCRIPT_PATH>> *)
---

# codex-image-gen

Shells out to the user's locally-installed `codex` CLI to generate raster images via their ChatGPT subscription. Each invocation generates `--generate N` variants and optionally has codex review them and select the `--select M` strongest.

## When to use

- User asks for a new bitmap image asset: icon, logo, faction emblem, illustration, photo, texture, sprite, hero/cover art, UI mockup, concept art.
- The output should be a `.png` file you (or the user) move into the project.

## When NOT to use

- User wants SVG, vector art, or code that procedurally draws (Canvas, CSS, HTML, p5.js, etc.).
- User wants to edit an existing image (resize, recolor, crop) — this tool only generates.
- User wants to modify an established icon system that already has a defined visual language in the repo — extend the existing system instead.
- The repo has its own image-generation tooling (e.g. a Fooocus MCP server, a different codex wrapper) — prefer that.

## How to invoke

```bash
node <<SCRIPT_PATH>> \
  --style "<style prompt — visual treatment>" \
  --subject "<subject prompt — what to depict>" \
  [--generate N] \
  [--select M] \
  [--debug]
```

### Parameters

- `--style` (required, free text). Describes the visual treatment: medium, lighting, palette, line weight, level of detail. Example: `"photorealistic studio product photo, soft lighting, neutral background"`, `"flat vector cartoon, thick black outlines, vibrant flat color, no gradients"`, `"oil painting, dramatic chiaroscuro, baroque, muted earth tones"`.
- `--subject` (required, free text). Describes what to depict, including any composition / framing / background notes. Be specific. Example: `"two metal swords crossed in an X, transparent background, centered, no scene"`. If you want transparency, say so — codex's default is to use chroma-key removal.
- `--generate` (optional, default 1). Number of variants to generate. Each variant burns ChatGPT subscription quota at ~3-5x the rate of a text turn.
- `--select` (optional, default 1; must be ≤ `--generate`). Number of variants to keep. When `select < generate`, codex reviews the generated variants and picks the strongest. When `select == generate`, the review step is skipped.
- `--debug` (optional flag). Keep the per-session tmp work dir on success. Default cleans it up to minimize disk impact. Failures always preserve tmp regardless. Only set this when you intend to inspect interim files.

### Output

JSON on stdout. Always inspect the result.

```json
{
  "ok": true,
  "generated": { "count": 4, "paths": [] },
  "selected": {
    "count": 2,
    "paths": [
      "/abs/cwd/codex-image-gen-output/<sessionId>-variant-2.png",
      "/abs/cwd/codex-image-gen-output/<sessionId>-variant-3.png"
    ],
    "expected": 2
  },
  "outputDir": "/abs/cwd/codex-image-gen-output",
  "workdir":   "/abs/cwd/.codex-image-gen-tmp/<sessionId>",
  "warnings": [],
  "durationMs": 345264
}
```

`ok` is true only when `generated.count == --generate` AND `selected.count == --select`. If `ok` is false, inspect `warnings` and `error`.

`selected.paths` is the canonical "use these" list and always points into the persistent output dir at `<cwd>/codex-image-gen-output/`. Filenames are sessionId-prefixed (e.g. `1716123456789-12345-variant-2.png`) so multiple runs in the same cwd don't collide. `generated.paths` is empty after the default cleanup; with `--debug` or on failure it surfaces tmp paths instead.

## After invoking

The tool copies selected files into `./codex-image-gen-output/` (relative to caller cwd) and removes the per-session tmp work dir on success. It does NOT move files to their final destination — that's your responsibility. After the tool returns:

1. Inspect the image(s) (Read the PNG path from `selected.paths` to view it).
2. If the result looks right, copy/move from `selected.paths` to the project's permanent asset directory. You'll typically want to drop the sessionId prefix from the filename when you do.
3. Add `codex-image-gen-output/` and `.codex-image-gen-tmp/` to the project's `.gitignore` if not already there.

## Cost & timing awareness

- Time: ~30-60s for one image, ~80-90s per variant when batching, plus an extra ~30-60s for the review step when `select < generate`. A 4-generate / 2-select run takes roughly 5-6 minutes.
- Quota: image turns burn ChatGPT subscription quota at 3-5x the rate of text turns, on a 5-hour rolling window plus a weekly cap. Be deliberate. Do not regenerate on every CI build — these are committed artifacts, not regenerable assets.
- Uses `gpt-image-2`. Fast variants (`quality=low`) are not exposed via this tool — codex picks quality automatically.

## Style prompt tips

- Be explicit about medium ("photorealistic", "flat vector", "watercolor", "3D render").
- Be explicit about lighting if it matters ("soft studio lighting", "dramatic rim light", "no lighting, flat color").
- For game icons, include "transparent background" and "centered, no scene clutter".
- For repeat-use asset families (e.g. faction emblems for a 4X game), keep the style prompt identical across calls to maintain visual coherence; vary only the subject prompt.
- For batch generation with selection, lean toward briefs that genuinely have multiple valid interpretations — otherwise codex's variants will be near-duplicates and the review step adds little.

## Failure modes

- `error: "codex exited with code N"` — usually auth (run `codex login`), out-of-quota (check ChatGPT plan limits), or codex sandbox refusal.
- `warnings: [...]` non-empty + `ok: true` — partial success. The fallbacks (mtime-based image discovery, mtime-based selection if codex didn't honor the `selected/` subfolder) kicked in. Worth re-running.
- `ok: false` with no error — codex generated fewer images than requested. Re-run.
