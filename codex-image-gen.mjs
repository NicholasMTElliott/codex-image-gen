#!/usr/bin/env node
/**
 * codex-image-gen
 *
 * Invoke OpenAI's codex CLI to generate raster images using the user's ChatGPT
 * subscription billing (NOT API tokens). Generates N variants and optionally
 * has codex review them and pick the best M.
 *
 * Usage:
 *   node codex-image-gen.mjs \
 *     --style "western cartoon, thick black outlines, vibrant flat color" \
 *     --subject "Kharr Dominion faction emblem, predator silhouette, deep red" \
 *     --generate 4 --select 2
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
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
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

function parseArgs(argv) {
  let style = '';
  let subject = '';
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
    else if (arg === '--generate') { generate = parseInt(next ?? '', 10); i++; }
    else if (arg === '--select') { select = parseInt(next ?? '', 10); i++; }
    else if (arg === '--name') { name = next ?? ''; i++; }
    else if (arg === '--out') { out = next ?? ''; i++; }
    else if (arg === '--debug') { debug = true; }
    else if (arg === '-h' || arg === '--help') { printUsage(process.stdout); process.exit(0); }
  }

  if (!style || !subject) { printUsage(process.stderr); process.exit(2); }
  if (!Number.isInteger(generate) || generate < 1) {
    process.stderr.write('error: --generate must be a positive integer\n');
    process.exit(2);
  }
  if (!Number.isInteger(select) || select < 1) {
    process.stderr.write('error: --select must be a positive integer\n');
    process.exit(2);
  }
  if (select > generate) {
    process.stderr.write('error: --select cannot exceed --generate\n');
    process.exit(2);
  }
  if (name && !/^[A-Za-z0-9._-]+$/.test(name)) {
    // Restrict to filename-safe chars to block path traversal and shell-meta
    // surprises. Users who want arbitrary paths can use --out instead.
    process.stderr.write('error: --name must contain only letters, digits, ., _, -\n');
    process.exit(2);
  }

  return { style, subject, generate, select, debug, name, out };
}

function printUsage(stream = process.stderr) {
  stream.write(
    `Usage: node codex-image-gen.mjs --style "<text>" --subject "<text>" [--generate N] [--select M] [--name SLUG] [--out DIR] [--debug]

Required:
  --style      Style prompt (free text — describes visual treatment)
  --subject    Subject prompt (free text — describes what to depict)

Optional:
  --generate   Number of variants to generate (default: 1)
  --select     Number of variants to keep (default: 1; must be <= generate)
               When select < generate, codex reviews the variants and picks
               the strongest. When select == generate, no review step runs.
  --name       Output filename slug. With --name kharr-emblem and select=1,
               the persistent file is "kharr-emblem.png"; with select>1, it's
               "kharr-emblem-1.png", "kharr-emblem-2.png", ... If a target
               filename already exists, falls back to a sessionId-suffixed
               name and emits a warning. Allowed chars: letters, digits, ., _,
               -. Without --name, files keep the default sessionId prefix.
  --out        Persistent output directory (relative to cwd, or absolute).
               Default: ./codex-image-gen-output/. Created if missing.
  --debug      Keep the per-session tmp dir after a successful run. By
               default tmp is cleaned up on success to minimize disk impact;
               failed runs always keep tmp for debugging regardless.

Output: selected images are copied to the persistent output directory:
  <outDir>/<sessionId>-<filename>.png       (default — sessionId prefix
                                             prevents cross-run collisions)
  <outDir>/<slug>[-<n>].png                 (with --name)

JSON on stdout reports both the persistent paths (selected.paths) and the
output dir. The interim per-session work dir lives at
  <cwd>/.codex-image-gen-tmp/<sessionId>/
and is removed automatically on a successful run unless --debug is passed
(or the run failed — failures preserve tmp so the user can investigate).

Add the output dir and ".codex-image-gen-tmp/" to your project's .gitignore.
`,
  );
}

function buildPrompt(args, outDir) {
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

  const env = { ...process.env };
  delete env.OPENAI_API_KEY;

  const prompt = buildPrompt(args, tmpOutputDir);

  let runResult;
  try {
    runResult = await runCodex(prompt, env, tmpOutputDir);
  } catch (e) {
    return emit({
      ok: false,
      generated: { count: 0, paths: [] },
      selected: { count: 0, paths: [], expected: args.select },
      outputDir: persistentOutputDir,
      workdir: sessionDir,
      warnings,
      error: `failed to spawn codex: ${e.message}`,
      durationMs: Date.now() - start,
    }, 1);
  }

  if (runResult.code !== 0) {
    return emit({
      ok: false,
      generated: { count: 0, paths: [] },
      selected: { count: 0, paths: [], expected: args.select },
      outputDir: persistentOutputDir,
      workdir: sessionDir,
      warnings,
      error: `codex exited with code ${runResult.code}. stderr tail: ${runResult.stderr.slice(-500).trim()}`,
      durationMs: Date.now() - start,
    }, 1);
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

  emit({
    ok,
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
    durationMs: Date.now() - start,
  }, ok ? 0 : 1);
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
