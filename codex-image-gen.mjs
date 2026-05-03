#!/usr/bin/env node
/**
 * codex-image-gen
 *
 * Invoke OpenAI's codex CLI to produce raster images using the user's ChatGPT
 * subscription billing (NOT API tokens). Two subcommands:
 *
 *   generate (default) — synthesize a new image from --style + --subject
 *   edit               — modify or combine reference image(s) per --instruction
 *
 * Usage:
 *   node codex-image-gen.mjs generate \
 *     --style "western cartoon, thick black outlines, vibrant flat color" \
 *     --subject "Kharr Dominion faction emblem, predator silhouette, deep red" \
 *     --generate 4 --select 2
 *
 *   node codex-image-gen.mjs edit \
 *     --reference alien.png --reference pose.png \
 *     --instruction "Render the character of @alien.png in the pose of @pose.png"
 *
 * The "generate" subcommand may be omitted (it is the default) — existing
 * callers using flags-only invocation continue to work unchanged.
 *
 * Output: selected images are copied to <cwd>/codex-image-gen-output/ with
 * sessionId-prefixed filenames so consecutive runs don't collide. JSON on
 * stdout reports paths + the persistent output dir + the tmp workdir.
 *
 * Tmp session work happens under <cwd>/.codex-image-gen-tmp/<sessionId>/ and
 * is cleaned up on successful completion to minimize disk churn. Pass --debug
 * to keep tmp on success; failures always preserve tmp regardless.
 *
 * Subscription billing requires OPENAI_API_KEY to be UNSET in the spawned env
 * — if present, codex silently switches to API token billing. We deliberately
 * do NOT override CODEX_HOME: codex stores its ChatGPT auth there, and
 * overriding it forces a fresh-install state that drops the user's login.
 * (codex#11435 parallel-session corruption is only a problem under concurrent
 * invocations; this tool is serial-by-design.)
 *
 * No npm dependencies. Requires Node 18+ and `codex` CLI on PATH.
 */

import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';

// Silence DEP0190 (spawn shell:true with args). shell:true is required on
// Windows because post-CVE-2024-27980 Node refuses to spawn .cmd shims any
// other way, and codex installs as codex.cmd via npm.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.code === 'DEP0190') return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

const IMAGE_EXTS = /\.(png|jpe?g|webp)$/i;
// @-token grammar in --instruction: same charset as --name (filename-safe).
// The capture requires the last char to be non-dot so trailing prose
// punctuation (e.g. "@pose.png." at end of sentence) isn't sucked into the
// token. The substitution boundary excludes dot too, so the substitution
// fires when followed by sentence punctuation. We rely on longest-first
// substitution to disambiguate when both "@cat" and "@cat.png" are staged.
const AT_TOKEN_RE = /@([A-Za-z0-9._-]*[A-Za-z0-9_-])/g;
const AT_TOKEN_BOUNDARY = '(?![A-Za-z0-9_-])';

// ---------- arg parsing ----------

function parseArgs(argv) {
  // First positional (no leading -) chooses subcommand. Absent or flag-first
  // → default to 'generate' for backward compat with 0.2.x callers.
  let mode = 'generate';
  let rest = argv;
  if (argv.length > 0 && !argv[0].startsWith('-')) {
    if (argv[0] === 'generate' || argv[0] === 'edit') {
      mode = argv[0];
      rest = argv.slice(1);
    } else {
      process.stderr.write(`error: unknown subcommand "${argv[0]}" (expected "generate" or "edit")\n`);
      process.exit(2);
    }
  }
  return mode === 'edit' ? parseEditArgs(rest) : parseGenerateArgs(rest);
}

function parseGenerateArgs(argv) {
  let style = '';
  let subject = '';
  let styleFile = '';
  let subjectFile = '';
  let generate = 1;
  let select = 1;
  let debug = false;
  let name = '';
  let out = '';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--style') { style = next ?? ''; i++; }
    else if (arg === '--subject') { subject = next ?? ''; i++; }
    else if (arg === '--style-file') { styleFile = next ?? ''; i++; }
    else if (arg === '--subject-file') { subjectFile = next ?? ''; i++; }
    else if (arg === '--generate') { generate = parseInt(next ?? '', 10); i++; }
    else if (arg === '--select') { select = parseInt(next ?? '', 10); i++; }
    else if (arg === '--name') { name = next ?? ''; i++; }
    else if (arg === '--out') { out = next ?? ''; i++; }
    else if (arg === '--debug') { debug = true; }
    else if (arg === '-h' || arg === '--help') { printUsage(process.stdout); process.exit(0); }
    else { usageErr(`unknown argument "${arg}" for generate mode`); }
  }

  // --style/--style-file (and --subject/--subject-file) are mutually exclusive.
  // Reject before reading so users get a clear "you set both" error rather
  // than silently picking one.
  if (style && styleFile) usageErr('--style and --style-file are mutually exclusive');
  if (subject && subjectFile) usageErr('--subject and --subject-file are mutually exclusive');
  if (styleFile) style = readPromptFile(styleFile, '--style-file');
  if (subjectFile) subject = readPromptFile(subjectFile, '--subject-file');

  if (!style || !subject) { printUsage(process.stderr); process.exit(2); }
  validateCommonArgs({ generate, select, name });

  return { mode: 'generate', style, subject, generate, select, debug, name, out };
}

function parseEditArgs(argv) {
  const references = [];
  let instruction = '';
  let instructionFile = '';
  let generate = 1;
  let select = 1;
  let debug = false;
  let name = '';
  let out = '';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--reference') { references.push(next ?? ''); i++; }
    else if (arg === '--instruction') { instruction = next ?? ''; i++; }
    else if (arg === '--instruction-file') { instructionFile = next ?? ''; i++; }
    else if (arg === '--generate') { generate = parseInt(next ?? '', 10); i++; }
    else if (arg === '--select') { select = parseInt(next ?? '', 10); i++; }
    else if (arg === '--name') { name = next ?? ''; i++; }
    else if (arg === '--out') { out = next ?? ''; i++; }
    else if (arg === '--debug') { debug = true; }
    else if (arg === '-h' || arg === '--help') { printUsage(process.stdout); process.exit(0); }
    else { usageErr(`unknown argument "${arg}" for edit mode`); }
  }

  if (instruction && instructionFile) usageErr('--instruction and --instruction-file are mutually exclusive');
  if (instructionFile) instruction = readPromptFile(instructionFile, '--instruction-file');
  if (!instruction) usageErr('edit mode requires --instruction or --instruction-file');
  if (references.length === 0) usageErr('edit mode requires at least one --reference <path>');
  for (const r of references) {
    if (!r) usageErr('--reference requires a path argument');
  }
  validateCommonArgs({ generate, select, name });

  return { mode: 'edit', references, instruction, generate, select, debug, name, out };
}

function validateCommonArgs({ generate, select, name }) {
  if (!Number.isInteger(generate) || generate < 1) usageErr('--generate must be a positive integer');
  if (!Number.isInteger(select) || select < 1) usageErr('--select must be a positive integer');
  if (select > generate) usageErr('--select cannot exceed --generate');
  // Restrict to filename-safe chars to block path traversal and shell-meta
  // surprises. Users who want arbitrary paths can use --out instead.
  if (name && !/^[A-Za-z0-9._-]+$/.test(name)) usageErr('--name must contain only letters, digits, ., _, -');
}

function usageErr(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(2);
}

function readPromptFile(path, flag) {
  let contents;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (e) {
    process.stderr.write(`error: failed to read ${flag} ${path}: ${e.message}\n`);
    process.exit(2);
  }
  // Trim leading/trailing whitespace — file editors typically add a trailing
  // newline that we don't want bleeding into the prompt. Internal newlines
  // (multi-line briefs) are preserved.
  const trimmed = contents.trim();
  if (!trimmed) {
    process.stderr.write(`error: ${flag} ${path} is empty\n`);
    process.exit(2);
  }
  return trimmed;
}

function printUsage(stream = process.stderr) {
  stream.write(
    `Usage:
  node codex-image-gen.mjs [generate] (--style "<text>" | --style-file <path>)
                                      (--subject "<text>" | --subject-file <path>)
                                      [--generate N] [--select M]
                                      [--name SLUG] [--out DIR] [--debug]

  node codex-image-gen.mjs edit --reference <path> [--reference <path>...]
                                (--instruction "<text>" | --instruction-file <path>)
                                [--generate N] [--select M]
                                [--name SLUG] [--out DIR] [--debug]

The "generate" subcommand may be omitted (it is the default).

generate mode — synthesize a new image from prompts:
  --style          Style prompt as inline text (visual treatment)
  --style-file     Read style prompt from a UTF-8 text file. Useful for long
                   multi-line briefs that don't shell-escape cleanly.
                   Mutually exclusive with --style.
  --subject        Subject prompt as inline text (what to depict)
  --subject-file   Read subject prompt from a UTF-8 text file. Mutually
                   exclusive with --subject.

edit mode — modify or combine reference images per a free-form instruction:
  --reference         Path to a reference image (.png/.jpg/.jpeg/.webp).
                      Repeatable. Each is staged into the codex working dir
                      as references/<basename>; basename collisions auto-
                      suffix to -2, -3, ... and emit a warning.
  --instruction       Free-form text describing what to do with the
                      references. Reference files in this text by @-token
                      using the staged basename, e.g. "match the character
                      of @alien.png in the pose of @pose.png". Tokens are
                      validated up-front — typos exit before spawning codex.
  --instruction-file  Read instruction from a UTF-8 text file. Mutually
                      exclusive with --instruction.

Common (both modes):
  --generate   Number of variants to generate (default: 1)
  --select     Number of variants to keep (default: 1; must be <= generate)
               When select < generate, codex reviews the variants and picks
               the strongest. When select == generate, no review step runs.
  --name       Output filename slug. With --name foo and select=1 the
               persistent file is "foo.png"; with select>1 it's "foo-1.png",
               "foo-2.png", ... If a target filename already exists, falls
               back to a sessionId-disambiguated name and emits a warning.
               Allowed chars: letters, digits, ., _, -. Without --name, files
               keep the default sessionId prefix.
  --out        Persistent output directory (relative to cwd, or absolute).
               Default: ./codex-image-gen-output/. Created if missing.
  --debug      Keep the per-session tmp dir after a successful run. By
               default tmp is cleaned up on success to minimize disk impact;
               failed runs always keep tmp for debugging regardless.

Output: JSON on stdout. selected.paths is the canonical "use these" list,
absolute paths inside the persistent output directory. The interim per-session
work dir lives at <cwd>/.codex-image-gen-tmp/<sessionId>/ and is removed
automatically on a successful run unless --debug is passed (or the run
failed — failures preserve tmp so the user can investigate).

Add the output dir and ".codex-image-gen-tmp/" to your project's .gitignore.
`,
  );
}

// ---------- reference staging + @-resolution (edit mode) ----------

function planStaging(references) {
  // Returns { entries, warnings }. Side-effects (file copies) happen later in
  // stageReferences — this pass is pure validation + name allocation, so we
  // can fail fast before mkdir'ing anything.
  // - dedups by absolute source path
  // - auto-suffixes basename collisions: foo.png + foo-2.png if two distinct
  //   sources share basename
  // - validates each source exists, is a file, and has an image extension
  const seen = new Map();
  const used = new Set();
  const entries = [];
  const warnings = [];
  for (const src of references) {
    const abs = resolve(src);
    if (seen.has(abs)) {
      warnings.push(`reference ${src} is a duplicate of an earlier reference; ignoring`);
      continue;
    }
    if (!existsSync(abs)) usageErr(`--reference ${src} does not exist`);
    let s;
    try { s = statSync(abs); } catch (e) { usageErr(`--reference ${src} unreadable: ${e.message}`); }
    if (!s.isFile()) usageErr(`--reference ${src} is not a regular file`);
    if (!IMAGE_EXTS.test(abs)) usageErr(`--reference ${src} extension not in {png,jpg,jpeg,webp}`);
    let stagedBase = basename(abs);
    if (used.has(stagedBase)) {
      const ext = extname(stagedBase);
      const stem = stagedBase.slice(0, -ext.length);
      let n = 2;
      while (used.has(`${stem}-${n}${ext}`)) n++;
      const renamed = `${stem}-${n}${ext}`;
      warnings.push(`reference ${src} basename collides with an earlier reference; staged as ${renamed} (use @${renamed} in --instruction)`);
      stagedBase = renamed;
    }
    used.add(stagedBase);
    const entry = { source: src, absSource: abs, staged: stagedBase, referenced: false };
    seen.set(abs, entry);
    entries.push(entry);
  }
  return { entries, warnings };
}

function resolveInstructionTokens(instruction, stagingEntries) {
  // Find every @<word> token and validate against staged basenames. On
  // success, substitute @<basename> → references/<basename> in the codex-
  // bound text. On any unknown token, exit 2 with the full mapping printed
  // so the user can correct typos before burning a codex call.
  const stagedSet = new Map(stagingEntries.map((e) => [e.staged, e]));
  const tokens = new Set();
  let m;
  while ((m = AT_TOKEN_RE.exec(instruction)) !== null) tokens.add(m[1]);
  AT_TOKEN_RE.lastIndex = 0;
  const unknown = [];
  for (const t of tokens) {
    if (stagedSet.has(t)) stagedSet.get(t).referenced = true;
    else unknown.push(t);
  }
  if (unknown.length > 0) {
    const known = stagingEntries.map((e) => e.staged).join(', ');
    process.stderr.write(`error: --instruction references unknown @-token(s): ${unknown.map((t) => '@' + t).join(', ')}\n`);
    process.stderr.write(`available staged references: ${known || '(none)'}\n`);
    process.exit(2);
  }
  // Substitute longest tokens first so that, when both "@cat" and "@cat.png"
  // are staged, "@cat.png" is replaced before the bare "@cat" regex scans
  // (the boundary alone can't tell them apart since "." is now allowed
  // immediately after a token).
  const ordered = [...tokens].sort((a, b) => b.length - a.length);
  let resolved = instruction;
  for (const t of ordered) {
    const re = new RegExp(`@${escapeRe(t)}${AT_TOKEN_BOUNDARY}`, 'g');
    resolved = resolved.replace(re, `references/${t}`);
  }
  return resolved;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function stageReferences(entries, refsDir) {
  mkdirSync(refsDir, { recursive: true });
  for (const e of entries) {
    copyFileSync(e.absSource, join(refsDir, e.staged));
  }
}

// ---------- prompt synthesis ----------

function buildGeneratePrompt(args, outDir) {
  const { style, subject, generate, select } = args;
  // Posix-style path for the prompt — codex normalizes either, but forward
  // slashes avoid backslash-escape ambiguity in its tool-call parsing.
  const outDirP = outDir.replace(/\\/g, '/');
  const lines = [
    `Please generate ${generate} bitmap raster image${generate > 1 ? 's' : ''} (PNG) using your built-in image_gen tool.`,
    `This is for an asset; output must be a bitmap, not SVG or code.`,
    ``,
    `Brief:`,
    `  Style: ${style}`,
    `  Subject: ${subject}`,
    ``,
    `After generation, copy the resulting PNG file${generate > 1 ? 's' : ''} to this absolute directory:`,
    `  ${outDirP}`,
    ``,
    `Use distinct filenames such as variant-1.png${generate > 1 ? `, variant-2.png, ...` : ''}.`,
    `That directory must contain exactly ${generate} PNG file${generate > 1 ? 's' : ''} when you are done.`,
  ];
  if (select < generate) {
    lines.push(
      ``,
      `Then review the ${generate} variants critically and pick the ${select} strongest based on:`,
      `  - fidelity to the Style brief`,
      `  - fidelity to the Subject brief`,
      `  - composition, clarity, visual appeal`,
      ``,
      `Copy the ${select} chosen file${select > 1 ? 's' : ''} into a subfolder named "selected" inside ${outDirP}.`,
      `The "selected" subfolder must contain exactly ${select} PNG file${select > 1 ? 's' : ''} when you are done.`,
    );
  }
  lines.push(
    ``,
    `Do not ask for confirmation. Proceed directly with generation and file placement, then stop.`,
  );
  return lines.join('\n');
}

function buildEditPrompt(args, outDir, resolvedInstruction, stagingEntries) {
  const { generate, select } = args;
  const outDirP = outDir.replace(/\\/g, '/');
  const refList = stagingEntries.map((e) => `  - references/${e.staged}`).join('\n');
  const lines = [
    `Please generate ${generate} bitmap raster image${generate > 1 ? 's' : ''} (PNG) using your built-in image_gen tool, derived from the reference image(s) below per the instructions.`,
    `This is for an asset; output must be a bitmap, not SVG or code.`,
    ``,
    `Reference images available in your working directory:`,
    refList,
    ``,
    `Instructions:`,
    resolvedInstruction,
    ``,
    `After generation, copy the resulting PNG file${generate > 1 ? 's' : ''} to this absolute directory:`,
    `  ${outDirP}`,
    ``,
    `Use distinct filenames such as variant-1.png${generate > 1 ? `, variant-2.png, ...` : ''}.`,
    `That directory must contain exactly ${generate} PNG file${generate > 1 ? 's' : ''} when you are done.`,
    `Do not modify or duplicate the files under references/ — they are inputs only.`,
  ];
  if (select < generate) {
    lines.push(
      ``,
      `Then review the ${generate} variants critically and pick the ${select} strongest based on:`,
      `  - fidelity to the reference image(s) and the Instructions`,
      `  - composition, clarity, visual appeal`,
      ``,
      `Copy the ${select} chosen file${select > 1 ? 's' : ''} into a subfolder named "selected" inside ${outDirP}.`,
      `The "selected" subfolder must contain exactly ${select} PNG file${select > 1 ? 's' : ''} when you are done.`,
    );
  }
  lines.push(
    ``,
    `Do not ask for confirmation. Proceed directly with generation and file placement, then stop.`,
  );
  return lines.join('\n');
}

// ---------- shared runtime ----------

function listImages(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && IMAGE_EXTS.test(e.name))
    .map((e) => join(dir, e.name))
    // mtime primary; filename tiebreaker so equal-mtime files (FAT32 2s
    // resolution, fast generation in the same ms) sort deterministically.
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs || a.localeCompare(b));
}

function runCodex(prompt, env, cwd) {
  return new Promise((resolveP, rejectP) => {
    // On Windows codex is a .cmd shim — post-CVE-2024-27980 Node refuses to
    // spawn .cmd without shell:true (EINVAL). shell:true emits DEP0190 (we
    // suppress it; args here are static flags + a path with no shell metachars).
    // Prompt itself is piped via stdin to dodge shell-arg-concat splitting.
    const isWin = process.platform === 'win32';
    // --skip-git-repo-check: our --cd target is always a fresh per-session
    // tmp dir (not a git repo), so codex's trusted-dir guard would refuse
    // every run. Safe here because our prompt only asks codex to generate
    // images and copy them into the same dir we created — no destructive
    // operations elsewhere.
    const child = spawn('codex', ['exec', '--full-auto', '--skip-git-repo-check', '--cd', cwd], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isWin,
    });
    let stderr = '';
    child.stdout.on('data', () => { /* discard — codex chatter is noise */ });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', rejectP);
    child.on('close', (code) => resolveP({ stderr, code: code ?? -1 }));
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function emit(r, code) {
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exit(code);
}

function buildResult(state) {
  const {
    ok, args, stagingEntries, instructionResolved,
    generatedPaths, persistentSelectedPaths, persistentOutputDir,
    sessionDir, warnings, cleanedUp, error, durationMs,
  } = state;
  const r = {
    ok,
    mode: args.mode,
    generated: {
      count: generatedPaths.length,
      // After cleanup the tmp paths are stale; surface [] so callers don't
      // get broken paths. With --debug or on partial failure, surface the
      // tmp paths so they're still inspectable.
      paths: cleanedUp ? [] : generatedPaths,
    },
    selected: {
      count: persistentSelectedPaths.length,
      paths: persistentSelectedPaths,
      expected: args.select,
    },
    outputDir: persistentOutputDir,
    workdir: sessionDir,
    warnings,
    durationMs,
  };
  if (args.mode === 'edit') {
    r.references = stagingEntries.map((e) => ({
      source: e.source,
      staged: e.staged,
      referenced: e.referenced,
    }));
    r.instruction = { raw: args.instruction, resolved: instructionResolved };
  }
  if (error) r.error = error;
  return r;
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const start = Date.now();
  const warnings = [];

  const cwd = process.cwd();
  const tmpRoot = resolve(cwd, '.codex-image-gen-tmp');
  mkdirSync(tmpRoot, { recursive: true });

  const sessionId = `${Date.now()}-${process.pid}`;
  const sessionDir = join(tmpRoot, sessionId);
  const tmpOutputDir = join(sessionDir, 'output');
  mkdirSync(tmpOutputDir, { recursive: true });

  // Persistent output dir for selected images. Default lives under the caller's
  // cwd; --out lets the caller redirect (e.g. straight into a repo's asset
  // folder). resolve() handles both relative and absolute paths.
  const persistentOutputDir = resolve(cwd, args.out || 'codex-image-gen-output');

  // Mode-specific prompt + (in edit mode) reference staging.
  let prompt;
  let stagingEntries = [];
  let instructionResolved = null;
  if (args.mode === 'edit') {
    const planned = planStaging(args.references);
    stagingEntries = planned.entries;
    warnings.push(...planned.warnings);
    instructionResolved = resolveInstructionTokens(args.instruction, stagingEntries);
    for (const e of stagingEntries) {
      if (!e.referenced) {
        warnings.push(`reference ${e.staged} was not @-mentioned in --instruction; codex may ignore it`);
      }
    }
    stageReferences(stagingEntries, join(tmpOutputDir, 'references'));
    prompt = buildEditPrompt(args, tmpOutputDir, instructionResolved, stagingEntries);
  } else {
    prompt = buildGeneratePrompt(args, tmpOutputDir);
  }

  const env = { ...process.env };
  delete env.OPENAI_API_KEY;

  let runResult;
  try {
    runResult = await runCodex(prompt, env, tmpOutputDir);
  } catch (e) {
    return emit(buildResult({
      ok: false, args, stagingEntries, instructionResolved,
      generatedPaths: [], persistentSelectedPaths: [],
      persistentOutputDir, sessionDir, warnings, cleanedUp: false,
      error: `failed to spawn codex: ${e.message}`,
      durationMs: Date.now() - start,
    }), 1);
  }

  if (runResult.code !== 0) {
    return emit(buildResult({
      ok: false, args, stagingEntries, instructionResolved,
      generatedPaths: [], persistentSelectedPaths: [],
      persistentOutputDir, sessionDir, warnings, cleanedUp: false,
      error: `codex exited with code ${runResult.code}. stderr tail: ${runResult.stderr.slice(-500).trim()}`,
      durationMs: Date.now() - start,
    }), 1);
  }

  let generatedPaths = listImages(tmpOutputDir);
  if (generatedPaths.length === 0) {
    const fallback = join(homedir(), '.codex', 'generated_images');
    const fallbackImgs = listImages(fallback);
    if (fallbackImgs.length > 0) {
      warnings.push(`no images in requested output dir; fell back to ${fallback}`);
      generatedPaths = fallbackImgs;
    }
  }
  if (generatedPaths.length !== args.generate) {
    warnings.push(`expected ${args.generate} generated image(s), found ${generatedPaths.length}`);
  }

  let selectedTmpPaths;
  const needsSelection = args.select < args.generate;
  if (needsSelection) {
    const selectedDir = join(tmpOutputDir, 'selected');
    selectedTmpPaths = listImages(selectedDir);
    if (selectedTmpPaths.length === 0) {
      warnings.push(`no "selected/" subfolder produced by codex; falling back to first ${args.select} generated image(s) by mtime`);
      selectedTmpPaths = generatedPaths.slice(0, args.select);
    } else if (selectedTmpPaths.length !== args.select) {
      warnings.push(`expected ${args.select} selected image(s), found ${selectedTmpPaths.length} in selected/`);
    }
  } else {
    selectedTmpPaths = generatedPaths.slice(0, args.select);
  }

  // Copy selected files to the persistent output dir. Filename strategy:
  //   - default: sessionId-prefixed (collision-safe across runs).
  //   - --name <slug>: <slug><ext> when select=1, otherwise <slug>-<n><ext>.
  //     On collision (re-run with same --name), fall back to a sessionId-
  //     disambiguated name and warn — caller's previous keepers stay intact.
  // Best-effort: a copy failure is recorded as a warning and reflected in
  // `ok` via the count check below.
  const persistentSelectedPaths = [];
  if (selectedTmpPaths.length > 0) {
    mkdirSync(persistentOutputDir, { recursive: true });
    for (let i = 0; i < selectedTmpPaths.length; i++) {
      const src = selectedTmpPaths[i];
      let dest;
      if (args.name) {
        const ext = extname(src);
        const preferred = args.select === 1
          ? `${args.name}${ext}`
          : `${args.name}-${i + 1}${ext}`;
        const preferredPath = join(persistentOutputDir, preferred);
        if (existsSync(preferredPath)) {
          const fallback = args.select === 1
            ? `${args.name}-${sessionId}${ext}`
            : `${args.name}-${sessionId}-${i + 1}${ext}`;
          dest = join(persistentOutputDir, fallback);
          warnings.push(`destination ${preferred} already exists; wrote ${fallback} instead`);
        } else {
          dest = preferredPath;
        }
      } else {
        dest = join(persistentOutputDir, `${sessionId}-${basename(src)}`);
      }
      try {
        copyFileSync(src, dest);
        persistentSelectedPaths.push(dest);
      } catch (e) {
        warnings.push(`failed to copy ${src} → ${dest}: ${e.message}`);
      }
    }
  }

  const ok =
    generatedPaths.length === args.generate &&
    persistentSelectedPaths.length === args.select;

  // Cleanup the tmp session dir on success unless --debug. Failures keep tmp
  // so the user can investigate. Best-effort: a failed cleanup is a warning,
  // not a failure of the run itself.
  const cleanedUp = ok && !args.debug;
  if (cleanedUp) {
    try {
      rmSync(sessionDir, { recursive: true, force: true });
    } catch (e) {
      warnings.push(`failed to clean up tmp session dir ${sessionDir}: ${e.message}`);
    }
  }

  emit(buildResult({
    ok, args, stagingEntries, instructionResolved,
    generatedPaths, persistentSelectedPaths, persistentOutputDir,
    sessionDir, warnings, cleanedUp,
    durationMs: Date.now() - start,
  }), ok ? 0 : 1);
}

main().catch((e) => {
  emit({
    ok: false,
    generated: { count: 0, paths: [] },
    selected: { count: 0, paths: [], expected: 0 },
    workdir: '',
    warnings: [],
    error: e.message,
    durationMs: 0,
  }, 1);
});
