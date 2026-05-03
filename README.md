# codex-image-gen

A small portable tool that lets Claude Code (or any CLI agent) generate or edit raster images by shelling out to OpenAI's `codex` CLI — billed against the user's ChatGPT subscription, not the API.

Two modes: `generate` synthesizes a new image from `--style` + `--subject` prompts; `edit` modifies or combines reference images per a free-form `--instruction` (apply a pose from one image to a character from another, produce variations of a character, etc.).

Ships with a Claude Code skill so the agent knows when and how to invoke it.

## Why

Claude Code can't generate images directly. The `codex` CLI can — and when authed against a ChatGPT subscription, image generation comes out of the plan's quota rather than burning API tokens. This tool wraps `codex exec` with the right flags, environment, and prompt template so an agent can call it without thinking about the gotchas.

For `edit` mode specifically: codex's `image_gen` tool can read existing PNGs that live inside its working directory, but `codex exec`'s `-i` flag does not reliably surface them. This tool stages each `--reference` into the per-session sandbox at `references/<basename>` so codex can read them, then resolves `@<basename>` tokens in the instruction text into those staged paths.

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

### `generate` mode (default — the `generate` keyword may be omitted)

POSIX (bash/zsh):

```bash
node ~/.codex-image-gen/codex-image-gen.mjs generate \
  --style "photorealistic, sharp detail, dramatic lighting, studio product photo" \
  --subject "two metal swords crossed in an X shape, transparent background, centered" \
  --generate 4 \
  --select 2
```

Windows PowerShell — `~` does not expand in arguments, use `$env:USERPROFILE` (or the absolute path):

```powershell
node "$env:USERPROFILE\.codex-image-gen\codex-image-gen.mjs" generate `
  --style "photorealistic, sharp detail, dramatic lighting, studio product photo" `
  --subject "two metal swords crossed in an X shape, transparent background, centered" `
  --generate 4 `
  --select 2
```

Windows `cmd.exe`:

```cmd
node "%USERPROFILE%\.codex-image-gen\codex-image-gen.mjs" generate ^
  --style "photorealistic, sharp detail, dramatic lighting, studio product photo" ^
  --subject "two metal swords crossed in an X shape, transparent background, centered" ^
  --generate 4 ^
  --select 2
```

### `edit` mode

```bash
node ~/.codex-image-gen/codex-image-gen.mjs edit \
  --reference path/to/alien.png \
  --reference path/to/pose.png \
  --instruction "Render the character of @alien.png in the pose of @pose.png. Match @alien.png's style exactly."
```

Output is JSON on stdout. By default, selected images are copied to `<cwd>/codex-image-gen-output/` with sessionId-prefixed filenames so consecutive runs don't collide; pass `--out` to redirect into a different directory and/or `--name` to control the filename. The interim per-session work dir under `<cwd>/.codex-image-gen-tmp/<sessionId>/` is removed automatically on success — pass `--debug` to keep it, and failures always preserve it for debugging.

### Parameters

#### `generate` mode

- `--style` (required if `--style-file` not given, free text). Visual treatment description.
- `--style-file` (alternative to `--style`). Path to a UTF-8 text file containing the style prompt. Useful for long multi-line briefs that don't shell-escape cleanly. Mutually exclusive with `--style`. Leading/trailing whitespace trimmed; internal newlines preserved.
- `--subject` (required if `--subject-file` not given, free text). What to depict, including framing and background notes.
- `--subject-file` (alternative to `--subject`). Path to a UTF-8 text file containing the subject prompt. Same trimming rules as `--style-file`.

#### `edit` mode

- `--reference` (required, repeatable). Path to a reference image (`.png`/`.jpg`/`.jpeg`/`.webp`). Each reference is copied into the per-session work dir at `references/<basename>` so codex can read it. Basename collisions are auto-suffixed (`cat.png`, `cat-2.png`) with a warning — use the staged name in `--instruction`. Duplicate paths are deduped silently.
- `--instruction` (required if `--instruction-file` not given). Free-form text describing what to do with the reference image(s). Reference files in this text by `@<staged-basename>`, e.g. `"Match @alien.png's character; match @pose.png's pose"`. Tokens are validated against the staged set up-front — a typo (`@alient.png` instead of `@alien.png`) exits with a helpful "did you mean…" message before spawning codex, so you don't burn quota on broken prompts. References that you pass but never `@`-mention emit a warning (codex may ignore them).
- `--instruction-file` (alternative to `--instruction`). Path to a UTF-8 text file containing the instruction. Same trimming rules as `--style-file`.

#### Common to both modes

- `--generate` (optional, default 1). Number of variants.
- `--select` (optional, default 1, must be ≤ `--generate`). Number to keep. When less than `--generate`, codex reviews and picks; otherwise no review runs.
- `--name` (optional). Output filename slug. With `--name kharr-emblem` and `--select 1`, the persistent file is `kharr-emblem.png`. With `--select 2+`, the files are `kharr-emblem-1.png`, `kharr-emblem-2.png`, …. On a re-run that would overwrite, the tool falls back to a sessionId-disambiguated name and emits a warning. Allowed chars: letters, digits, `.`, `_`, `-`. Without `--name`, the default sessionId-prefixed naming is used.
- `--out` (optional). Persistent output directory (relative to cwd, or absolute). Default `./codex-image-gen-output/`. Combine with `--name` to drop selected images straight into a project's asset folder.
- `--debug` (optional flag). Keep the per-session tmp work dir after a successful run. Default behavior cleans it up to minimize disk impact. Failed runs always preserve tmp regardless of this flag.

### Output JSON shape

```json
{
  "ok": true,
  "mode": "generate",
  "generated": { "count": 4, "paths": [] },
  "selected":  {
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

In `edit` mode, the JSON adds two extra fields:

```json
{
  "mode": "edit",
  "references": [
    { "source": "/abs/path/alien.png", "staged": "alien.png", "referenced": true },
    { "source": "/abs/path/pose.png",  "staged": "pose.png",  "referenced": true }
  ],
  "instruction": {
    "raw":      "Render the character of @alien.png in the pose of @pose.png.",
    "resolved": "Render the character of references/alien.png in the pose of references/pose.png."
  }
}
```

`ok` is `true` only when generated count matches `--generate` and selected count matches `--select`.

`selected.paths` is the canonical "use these" list and always points to the persistent output dir. `generated.paths` is empty after a successful cleanup (the tmp paths would be stale); pass `--debug` to surface the tmp paths instead, or look at `workdir` (preserved on failures or `--debug`).

`references[].referenced` is `true` when the staged file appeared as an `@`-token in the instruction. A `false` entry triggers a warning — codex may ignore the reference, so either drop it from the call or `@`-mention it.

Inspect `warnings` for fallbacks (mtime-based discovery if codex didn't write to the requested directory, mtime-based selection if codex didn't produce a `selected/` subfolder, basename-collision auto-suffix in `edit` mode, duplicate-reference dedup, copy/cleanup failures).

## Using it from Claude Code

Once installed, **restart Claude Code** if it was already running — it loads skills and settings at startup. After that, just ask for an image in any project; Claude reads the skill description, decides it matches your request, and runs the tool for you.

Example `generate` dialogue:

> **You:** Generate a faction emblem for my game — predator silhouette, deep red, flat vector style with thick black outlines, transparent background.
>
> **Claude:** *(invokes `node ~/.codex-image-gen/codex-image-gen.mjs --style "flat vector, thick black outlines, deep red palette, transparent background" --subject "predator silhouette faction emblem, centered, no scene"`, waits ~45s, then opens the resulting PNG to show you and proposes a destination path)*

Example `edit` dialogue:

> **You:** Take `alien.png` and pose it like `pose.png`.
>
> **Claude:** *(invokes `node ~/.codex-image-gen/codex-image-gen.mjs edit --reference alien.png --reference pose.png --instruction "Render the character of @alien.png in the pose of @pose.png. Keep the style of @alien.png exactly."`, waits ~60s, opens the resulting PNG)*

Claude knows when **not** to use the skill — for SVG/vector output, ASCII art, code that draws (Canvas/CSS/HTML), pixel-perfect edits like resize/recolor/crop, or modifications of an established icon system in the repo, it'll fall back to writing code or editing files directly. Those exclusions are spelled out in the skill's `description` field, which the model reads to decide whether to load it.

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

By default, the tool copies the **selected** images into `./codex-image-gen-output/` with sessionId-prefixed filenames (e.g. `1716123456789-12345-variant-2.png`). Use `--name` to give the file a known slug (e.g. `kharr-emblem.png`) and/or `--out` to redirect to a different directory (e.g. `--out assets/icons`). The interim per-session work dir under `./.codex-image-gen-tmp/<sessionId>/` is cleaned up on success unless `--debug` is passed.

After invocation:
1. Inspect the image(s) — use `selected.paths` from the JSON output.
2. If you didn't redirect with `--out`, move desired files out of `./codex-image-gen-output/` to your final destination (or rename them in place to drop the sessionId prefix — `--name` avoids that step on the next run).
3. Add the output dir and `.codex-image-gen-tmp/` to your project's `.gitignore` so generated artifacts don't get committed.

If a run fails (`ok: false`) the tmp work dir is preserved so you can investigate. Pass `--debug` to keep tmp on a successful run too. It's safe to delete `./codex-image-gen-tmp/` and `./codex-image-gen-output/` whenever you've moved the keepers — there's no state in either dir the tool needs across runs.

## Design notes

- **Why no npm deps**: keeps install trivial. Just `node install.mjs`. No `node_modules`, no version pinning, no transitive supply chain.
- **Why we delete `OPENAI_API_KEY`**: codex routes to API billing if it sees that variable, silently. We force subscription routing by stripping it from the spawned env.
- **Why we don't override `CODEX_HOME`**: codex stores its ChatGPT auth there. Override → fresh-install state → no auth → 401. The codex#11435 parallel-session corruption bug (which a per-session `CODEX_HOME` *would* dodge) only matters under concurrent invocation; this tool is serial-by-design.
- **Why prompt is piped via stdin**: `codex exec` accepts the prompt as a positional arg, but on Windows with `shell:true` (required to spawn `codex.cmd` post-CVE-2024-27980) Node concatenates args without escaping, so a multi-word prompt gets split. Stdin sidesteps the whole issue.
- **Why `--full-auto`**: skips codex's per-shell-command approval prompts so the workflow is hands-off.
- **Why `--cd` to the session output dir**: keeps codex's `workspace-write` sandbox confined to that directory. It can read from `~/.codex/` (its own state) but can only write into our session dir.
- **Why `edit` mode stages references via copy instead of `codex exec -i`**: in practice, codex's `image_gen` tool reads images that exist inside its working directory, but the `-i path/to/file` argument does not reliably surface external files into that workspace. Copying each reference into `<sessionDir>/output/references/<basename>` is portable across operating systems (no symlink permission issues on Windows, no same-filesystem constraint of hardlinks) and the disk overhead is trivial since references are deleted with the rest of tmp on success.
- **Why `@<basename>` substitution in `--instruction`**: the model needs the literal staged path (`references/alien.png`) inside the prompt, but the user wrote the prompt before knowing the staging dir. The `@`-token form lets the user write naturally with the basename they passed, gets validated against the staged set up-front (so typos fail before burning quota), and is substituted into the codex-bound prompt automatically.

## Compatibility notes

- Live-tested on Windows 11 + codex CLI 0.125 against a ChatGPT Team plan. POSIX (macOS, Linux) is exercised by CI (Ubuntu + macOS, Node 18/20/22) via the fake-codex test harness, but the live billing path on POSIX is unverified — please open an issue if you hit anything platform-specific against a real ChatGPT subscription.
- `shell: true` is enabled on Windows only (required to spawn the `codex.cmd` shim post-CVE-2024-27980); on POSIX the script uses `shell: false` since `codex` resolves to a real binary.
- Requires Node 18+ for nullish coalescing (`??`) and `process.removeAllListeners`.

## License

MIT — see [LICENSE](LICENSE).

## Contributing

Issues and PRs welcome at https://github.com/NicholasMTElliott/codex-image-gen. The tool is small (single ~350-line `.mjs` file) and intentionally zero-dep; please preserve both properties when proposing changes.
