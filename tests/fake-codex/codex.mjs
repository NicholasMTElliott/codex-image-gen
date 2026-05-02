#!/usr/bin/env node
/**
 * Fake codex CLI — used by the test suite to exercise codex-image-gen.mjs
 * without burning real subscription quota or making network calls.
 *
 * Behavior:
 *   - `codex --version`: prints a fake version, exits 0. Used by install.mjs's
 *     prereq check.
 *   - `codex exec --full-auto --cd <outdir>`: reads the prompt from stdin,
 *     parses it for the requested generate / select counts, drops fake PNG
 *     files into <outdir>, optionally creates <outdir>/selected/ with a
 *     subset, then exits.
 *
 * Test-control env vars (read at runtime — set by tests):
 *   FAKE_CODEX_EXIT          override exit code (default: 0)
 *   FAKE_CODEX_STDERR        if set, written to stderr before exit
 *   FAKE_CODEX_GENERATE      override generate count (default: parse prompt)
 *   FAKE_CODEX_SELECT        override select count (default: parse prompt)
 *   FAKE_CODEX_SKIP_SELECTED skip creating selected/ subfolder even if asked
 *
 * Always-on side effect: writes <outdir>/.fake-codex-meta.json containing
 * the captured prompt, argv, and a snapshot of relevant env vars. Tests
 * read this to assert on prompt content / env preservation. The .json
 * extension means the tool's image-discovery (which filters on png/jpg/
 * webp) won't pick it up.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 8-byte PNG magic + minimal IHDR/IDAT/IEND so it'd survive `file --mime-type`.
// We only need the magic header for the live-smoke validator; tests against the
// fake just check filename/extension, but a real PNG byte stream is harmless.
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
  0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44,
  0xAE, 0x42, 0x60, 0x82,
]);

const argv = process.argv.slice(2);

// --version: stub for install.mjs prereq check.
if (argv[0] === '--version' || argv.includes('--version')) {
  process.stdout.write('fake-codex 0.0.0\n');
  process.exit(0);
}

// Find --cd <outdir>
let outDir = process.cwd();
const cdIdx = argv.indexOf('--cd');
if (cdIdx >= 0 && argv[cdIdx + 1]) outDir = argv[cdIdx + 1];

// Read prompt from stdin
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const prompt = await readStdin();

// Parse counts from prompt (or honor env overrides)
function intEnv(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

const promptGenMatch = prompt.match(/generate (\d+) bitmap raster image/i);
const promptSelMatch = prompt.match(/pick the (\d+) strongest/i);

const generate = intEnv('FAKE_CODEX_GENERATE', promptGenMatch ? parseInt(promptGenMatch[1], 10) : 1);
const select = intEnv('FAKE_CODEX_SELECT', promptSelMatch ? parseInt(promptSelMatch[1], 10) : generate);
const wantsSelected = promptSelMatch != null && process.env.FAKE_CODEX_SKIP_SELECTED !== '1';

// Ensure output dir exists
mkdirSync(outDir, { recursive: true });

// Write fake variants
const writtenVariants = [];
for (let i = 1; i <= generate; i++) {
  const p = join(outDir, `variant-${i}.png`);
  writeFileSync(p, PNG_BYTES);
  writtenVariants.push(p);
}

// Write selected/ subfolder if prompt asked for selection
const writtenSelected = [];
if (wantsSelected) {
  const selDir = join(outDir, 'selected');
  mkdirSync(selDir, { recursive: true });
  for (let i = 1; i <= Math.min(select, generate); i++) {
    const p = join(selDir, `variant-${i}.png`);
    writeFileSync(p, PNG_BYTES);
    writtenSelected.push(p);
  }
}

// Always emit meta for tests
const meta = {
  prompt,
  argv,
  cwd: process.cwd(),
  outDir,
  generate,
  select,
  wantsSelected,
  writtenVariants,
  writtenSelected,
  env: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
    CODEX_HOME: process.env.CODEX_HOME ?? null,
    HOME: process.env.HOME ?? null,
    USERPROFILE: process.env.USERPROFILE ?? null,
  },
};
writeFileSync(join(outDir, '.fake-codex-meta.json'), JSON.stringify(meta, null, 2));

// Optional stderr
if (process.env.FAKE_CODEX_STDERR) {
  process.stderr.write(process.env.FAKE_CODEX_STDERR);
  if (!process.env.FAKE_CODEX_STDERR.endsWith('\n')) process.stderr.write('\n');
}

// Exit
const exitCode = intEnv('FAKE_CODEX_EXIT', 0);
process.exit(exitCode);
