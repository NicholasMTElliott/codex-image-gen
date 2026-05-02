# codex-image-gen

A small portable tool that lets Claude Code (or any CLI agent) generate raster images by shelling out to OpenAI's `codex` CLI — billed against the user's ChatGPT subscription, not the API.

Ships with a Claude Code skill so the agent knows when and how to invoke it.

## Why

Claude Code can't generate images directly. The `codex` CLI can — and when authed against a ChatGPT subscription, image generation comes out of the plan's quota rather than burning API tokens. This tool wraps `codex exec` with the right flags, environment, and prompt template so an agent can call it without thinking about the gotchas.

## What's in this directory

| File | Purpose |
|------|---------|
| `codex-image-gen.mjs` | The tool. Plain Node ESM, no npm dependencies. |
| `install.mjs` | Cross-platform installer. Copies the tool to `~/.codex-image-gen/` and the skill to `~/.claude/skills/codex-image-gen/`. |
| `SKILL.md` | Claude Code skill template. The installer fills in the resolved install path. |
| `README.md` | This file. |

## Prerequisites

1. **Node 18+** on `PATH`.
2. **`codex` CLI** on `PATH`, authed against a ChatGPT plan.
   - Install: see https://github.com/openai/codex for the current canonical install command on your platform.
   - Auth: `codex login` (uses ChatGPT account; opens a browser for OAuth).
3. **A paid ChatGPT plan** (Plus, Pro, or Team). The free tier does not include image generation. Plus is workable for occasional use; Pro is recommended if you batch-generate assets.
4. **Claude Code** (only needed if you want the skill auto-invoked from inside Claude Code).

`codex` image generation routes to subscription billing only when `OPENAI_API_KEY` is **not set** in the environment. The wrapper deletes that variable before spawning codex, so the user's shell can have the API key set for other purposes without breaking subscription routing for this tool.

## Install

Pick whichever path you prefer — both end at `node install.mjs`.

### Option A — Download a release zip (recommended for one-off use)

1. Grab the latest `codex-image-gen-*.zip` from [Releases](https://github.com/NicholasMTElliott/codex-image-gen/releases/latest).
2. Extract it anywhere — the extraction location doesn't matter; `install.mjs` copies what it needs into `~/.codex-image-gen/`.
3. From inside the extracted directory:
   ```bash
   node install.mjs
   ```

### Option B — Clone the repo (recommended if you want `git pull` updates or plan to contribute)

```bash
git clone https://github.com/NicholasMTElliott/codex-image-gen.git
cd codex-image-gen
node install.mjs
```

### What the installer does

1. Verifies `node` and `codex` are on `PATH`.
2. Copies `codex-image-gen.mjs` and `README.md` to `~/.codex-image-gen/`.
3. Renders `SKILL.md` with the absolute install path baked in and writes it to `~/.claude/skills/codex-image-gen/SKILL.md`.
4. Auto-patches the `permissions.allow` array in `~/.claude/settings.json` with the `Bash(...)` rule that pre-approves the tool for Claude Code (idempotent — safe to re-run; falls back to printing the rule if `settings.json` is malformed).

To remove:

```bash
node install.mjs --uninstall
```

## Manual invocation

```bash
node ~/.codex-image-gen/codex-image-gen.mjs \
  --style "photorealistic, sharp detail, dramatic lighting, studio product photo" \
  --subject "two metal swords crossed in an X shape, transparent background, centered" \
  --generate 4 \
  --select 2
```

Output is JSON on stdout with absolute paths to generated and selected images. Files live in `./.codex-image-gen-tmp/<sessionId>/output/` (relative to the caller's `cwd`).

### Parameters

- `--style` (required, free text). Visual treatment description.
- `--subject` (required, free text). What to depict, including framing and background notes.
- `--generate` (optional, default 1). Number of variants.
- `--select` (optional, default 1, must be ≤ `--generate`). Number to keep. When less than `--generate`, codex reviews and picks; otherwise no review runs.

### Output JSON shape

```json
{
  "ok": true,
  "generated": { "count": 4, "paths": ["/abs/.../variant-1.png", "..."] },
  "selected":  { "count": 2, "paths": ["/abs/.../selected/variant-2.png", "..."], "expected": 2 },
  "workdir": "/abs/.../.codex-image-gen-tmp/<sessionId>",
  "warnings": [],
  "durationMs": 345264
}
```

`ok` is `true` only when generated count matches `--generate` and selected count matches `--select`. Inspect `warnings` for fallbacks (mtime-based discovery if codex didn't write to the requested directory, mtime-based selection if codex didn't produce a `selected/` subfolder).

## Using it from Claude Code

Once installed, **restart Claude Code** if it was already running — it loads skills and settings at startup. After that, just ask for an image in any project; Claude reads the skill description, decides it matches your request, and runs the tool for you.

Example dialogue:

> **You:** Generate a faction emblem for my game — predator silhouette, deep red, flat vector style with thick black outlines, transparent background.
>
> **Claude:** *(invokes `node ~/.codex-image-gen/codex-image-gen.mjs --style "flat vector, thick black outlines, deep red palette, transparent background" --subject "predator silhouette faction emblem, centered, no scene"`, waits ~45s, then opens the resulting PNG to show you and proposes a destination path)*

Claude knows when **not** to use the skill too — for SVG/vector output, ASCII art, code that draws (Canvas/CSS/HTML), edits to existing images, or modifications of an established icon system in the repo, it'll fall back to writing code or editing files directly. Those exclusions are spelled out in the skill's `description` field, which the model reads to decide whether to load it.

## Updating

If you installed via **release zip**:

1. Download the latest `codex-image-gen-*.zip` from [Releases](https://github.com/NicholasMTElliott/codex-image-gen/releases/latest).
2. Extract over your existing extracted directory (or anywhere — location doesn't matter).
3. Re-run `node install.mjs` from inside the new extracted dir.

If you installed via **`git clone`**:

```bash
cd codex-image-gen
git pull
node install.mjs
```

Either way, the installer is idempotent: re-running overwrites the installed copy in `~/.codex-image-gen/`, re-renders `SKILL.md`, and detects the existing allow rule in `~/.claude/settings.json` without duplicating it.

## Troubleshooting

If a manual run fails or the skill isn't being invoked, work down this list:

1. **Manual smoke test** — isolates Node/codex issues from Claude-Code issues:
   ```bash
   node ~/.codex-image-gen/codex-image-gen.mjs --help
   node ~/.codex-image-gen/codex-image-gen.mjs --style "studio photo, soft lighting" --subject "a red apple on white background"
   ```
   If this fails, the problem is upstream of Claude Code (auth, quota, codex install).

2. **Auth failure** (401 / "Missing bearer or basic authentication") — your codex ChatGPT session expired. Run `codex login` again.

3. **Quota exhausted** — codex returns a quota error. Wait for the 5-hour rolling window to reset, or upgrade your ChatGPT plan.

4. **Skill not auto-invoked from Claude Code** — verify install state:
   - `~/.claude/skills/codex-image-gen/SKILL.md` exists and contains an absolute path (no `<<INSTALL_PATH>>` / `<<SCRIPT_PATH>>` placeholders left from rendering).
   - `~/.claude/settings.json`'s `permissions.allow` array contains a `Bash(node /abs/path/to/codex-image-gen.mjs *)` rule.
   - **Restart Claude Code** if it was running when you installed — it doesn't hot-reload skills or settings.

5. **Worried about accidental API billing** — the wrapper strips `OPENAI_API_KEY` from the spawned env before invoking codex, so subscription routing is locked in regardless of what your shell has set. You can verify by running `codex` manually with the env var set vs unset and observing the billing route in codex's session log under `~/.codex/sessions/`.

## Cost & timing

- ~30-60s per image variant. Selection step adds ~30-60s.
- Image turns consume ChatGPT subscription quota at roughly 3-5× the rate of text turns. There is a 5-hour rolling cap and a weekly cap. ChatGPT Plus is tight for ~20-image batches; Pro is recommended for heavier use.
- Uses `gpt-image-2`. Quality is selected automatically by codex.

## Caller responsibilities

The tool puts images in `./.codex-image-gen-tmp/<sessionId>/output/` — a temp session directory in the caller's working directory. It does **not** move final images to a permanent location.

After invocation:
1. Inspect the image(s).
2. Copy/move desired files from `selected.paths` to your final destination.
3. Add `.codex-image-gen-tmp/` to your project's `.gitignore`.

The tmp dir accumulates one subfolder per run. It's safe to delete the entire `.codex-image-gen-tmp/` directory whenever you've moved the keepers out — there's no state in there the tool needs across runs.

## Design notes

- **Why no npm deps**: keeps install trivial. Just `node install.mjs`. No `node_modules`, no version pinning, no transitive supply chain.
- **Why we delete `OPENAI_API_KEY`**: codex routes to API billing if it sees that variable, silently. We force subscription routing by stripping it from the spawned env.
- **Why we don't override `CODEX_HOME`**: codex stores its ChatGPT auth there. Override → fresh-install state → no auth → 401. The codex#11435 parallel-session corruption bug (which a per-session `CODEX_HOME` *would* dodge) only matters under concurrent invocation; this tool is serial-by-design.
- **Why prompt is piped via stdin**: `codex exec` accepts the prompt as a positional arg, but on Windows with `shell:true` (required to spawn `codex.cmd` post-CVE-2024-27980) Node concatenates args without escaping, so a multi-word prompt gets split. Stdin sidesteps the whole issue.
- **Why `--full-auto`**: skips codex's per-shell-command approval prompts so the workflow is hands-off.
- **Why `--cd` to the session output dir**: keeps codex's `workspace-write` sandbox confined to that directory. It can read from `~/.codex/` (its own state) but can only write into our session dir.

## Compatibility notes

- Live-tested on Windows 11 + codex CLI 0.125 against a ChatGPT Team plan. POSIX (macOS, Linux) is exercised by CI (Ubuntu + macOS, Node 18/20/22) via the fake-codex test harness, but the live billing path on POSIX is unverified — please open an issue if you hit anything platform-specific against a real ChatGPT subscription.
- `shell: true` is enabled on Windows only (required to spawn the `codex.cmd` shim post-CVE-2024-27980); on POSIX the script uses `shell: false` since `codex` resolves to a real binary.
- Requires Node 18+ for nullish coalescing (`??`) and `process.removeAllListeners`.

## License

MIT — see [LICENSE](LICENSE).

## Contributing

Issues and PRs welcome at https://github.com/NicholasMTElliott/codex-image-gen. The tool is small (single ~250-line `.mjs` file) and intentionally zero-dep; please preserve both properties when proposing changes.
