#!/usr/bin/env node
/**
 * codex-image-gen installer
 *
 * Copies the tool to ~/.codex-image-gen/ and registers a skill with each
 * supported coding-agent harness. The same rendered SKILL.md (Anthropic-style
 * frontmatter) is dropped into every harness's user-global skills dir; harnesses
 * that don't recognize a particular frontmatter field ignore it.
 *
 * Supported targets (current):
 *   - claude    -> ~/.claude/skills/codex-image-gen/SKILL.md
 *                  + permissions.allow patch in ~/.claude/settings.json
 *   - opencode  -> ~/.config/opencode/skills/codex-image-gen/SKILL.md
 *                  (opencode is permissive by default; no settings patch)
 *   - cline     -> ~/.cline/skills/codex-image-gen/SKILL.md
 *                  (Cline's user-global Skills system; no settings patch)
 *   - cursor    -> ~/.cursor/skills/codex-image-gen/SKILL.md
 *                  (Cursor's cursor-specific Skills system; no settings patch)
 *   - agents    -> ~/.agents/skills/codex-image-gen/SKILL.md
 *                  (cross-harness shared skills dir read by Cursor + opencode
 *                  per their docs; no settings patch. EXPLICIT-ONLY — never
 *                  auto-installed even if ~/.agents/ exists, because that dir
 *                  is also read by harnesses that have their own per-harness
 *                  install path, and writing to both locations produces
 *                  duplicate skill entries. Use --target=agents to install,
 *                  typically alongside --no-cursor / --no-opencode to dedupe.)
 *
 * Usage:
 *   node install.mjs                                          # install (auto-detect)
 *   node install.mjs --target=claude,opencode,cline,cursor    # explicit targets
 *   node install.mjs --all                                    # every known target, even undetected
 *   node install.mjs --no-opencode                            # exclude one target from default set
 *   node install.mjs --list-targets                           # show targets + detection state, exit
 *   node install.mjs --uninstall                              # remove tool + every target's skill dir
 *
 * Auto-detection rules:
 *   - claude:   default-on (installed even if ~/.claude/ doesn't exist yet —
 *               this preserves historical behavior; most users running this
 *               installer have Claude Code installed and may not have launched
 *               it yet to create the dir).
 *   - opencode: installed only if ~/.config/opencode/ exists, OR explicitly
 *               requested via --target / --all.
 *   - cline:    installed only if ~/.cline/ exists, OR explicitly requested.
 *   - cursor:   installed only if ~/.cursor/ exists, OR explicitly requested.
 *   - agents:   EXPLICIT-ONLY. Never auto-installed (even if ~/.agents/
 *               exists) — the dir is read by other harnesses we already
 *               install to, so auto-installing here would produce duplicate
 *               skill entries. Use --target=agents to install.
 *
 * Prereqs (verified during install):
 *   - Node 18+ on PATH
 *   - codex CLI on PATH (run `codex login` separately if not yet authed)
 */

import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const INSTALL_DIR = join(HOME, '.codex-image-gen');

/**
 * Target registry. Each entry describes one coding-agent harness we know how
 * to register with. Adding a new harness = adding an entry here (and likely a
 * test case).
 *
 * Fields:
 *   id            stable short name used in --target= and --no-<id> flags
 *   label         human-readable name for log output
 *   skillDir      where the rendered SKILL.md goes
 *   settingsPath  permissions config file (null if the harness has no allowlist
 *                 we need to patch)
 *   detectPath    presence of this dir/file means the harness is installed
 *   defaultOn     true => included in the default install set even when not
 *                 detected; false => only included if detected or explicit.
 *   explicitOnly  true => never included in the default set, even if the
 *                 detectPath exists. Only --target=<id> or --all will include
 *                 it. Used for cross-harness shared paths where auto-install
 *                 would duplicate other targets.
 */
const TARGETS = [
  {
    id: 'claude',
    label: 'Claude Code',
    skillDir: join(HOME, '.claude', 'skills', 'codex-image-gen'),
    settingsPath: join(HOME, '.claude', 'settings.json'),
    detectPath: join(HOME, '.claude'),
    defaultOn: true,
  },
  {
    id: 'opencode',
    label: 'opencode',
    skillDir: join(HOME, '.config', 'opencode', 'skills', 'codex-image-gen'),
    settingsPath: null,
    detectPath: join(HOME, '.config', 'opencode'),
    defaultOn: false,
  },
  {
    id: 'cline',
    label: 'Cline',
    skillDir: join(HOME, '.cline', 'skills', 'codex-image-gen'),
    settingsPath: null,
    detectPath: join(HOME, '.cline'),
    defaultOn: false,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    skillDir: join(HOME, '.cursor', 'skills', 'codex-image-gen'),
    settingsPath: null,
    detectPath: join(HOME, '.cursor'),
    defaultOn: false,
  },
  {
    id: 'agents',
    label: 'Agents (cross-harness)',
    skillDir: join(HOME, '.agents', 'skills', 'codex-image-gen'),
    settingsPath: null,
    detectPath: join(HOME, '.agents'),
    defaultOn: false,
    explicitOnly: true,
  },
];

const KNOWN_IDS = new Set(TARGETS.map((t) => t.id));

const args = process.argv.slice(2);

function log(msg) {
  process.stdout.write(msg + '\n');
}

function err(msg) {
  process.stderr.write('ERROR: ' + msg + '\n');
}

// Multi-line stderr without the ERROR: prefix (continuation lines / guidance).
function warn(msg) {
  process.stderr.write(msg + '\n');
}

/**
 * Run `<cmd> --version` and return the trimmed stdout, or null on failure.
 * Used to both check presence and surface the resolved version in the install
 * log so support requests can include it without further prompting.
 */
function getVersion(cmd) {
  try {
    return execSync(`${cmd} --version`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const out = {
    uninstall: false,
    listTargets: false,
    all: false,
    explicit: null,   // Set<string> | null
    excludes: new Set(),
    help: false,
  };
  for (const a of argv) {
    if (a === '--uninstall') out.uninstall = true;
    else if (a === '--list-targets') out.listTargets = true;
    else if (a === '--all') out.all = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a.startsWith('--target=')) {
      const raw = a.slice('--target='.length);
      const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.length === 0) {
        err(`--target= requires at least one id. Known: ${[...KNOWN_IDS].join(', ')}`);
        process.exit(2);
      }
      const unknown = ids.filter((id) => !KNOWN_IDS.has(id));
      if (unknown.length) {
        err(`unknown target(s): ${unknown.join(', ')}. Known: ${[...KNOWN_IDS].join(', ')}`);
        process.exit(2);
      }
      out.explicit = out.explicit ?? new Set();
      for (const id of ids) out.explicit.add(id);
    } else if (a.startsWith('--no-')) {
      const id = a.slice('--no-'.length);
      if (!KNOWN_IDS.has(id)) {
        err(`unknown target id in ${a}. Known: ${[...KNOWN_IDS].join(', ')}`);
        process.exit(2);
      }
      out.excludes.add(id);
    } else {
      err(`unknown argument: ${a}`);
      err(`run with --help for usage`);
      process.exit(2);
    }
  }
  return out;
}

function printHelp() {
  log(`codex-image-gen installer

Usage:
  node install.mjs                                          install (auto-detect targets)
  node install.mjs --target=claude,opencode,cline,cursor    explicit target list
  node install.mjs --all                                    install to every known target
  node install.mjs --no-opencode                            exclude target from default set
  node install.mjs --list-targets                           show targets + detection state
  node install.mjs --uninstall                              remove tool + every skill dir

Known targets: ${[...KNOWN_IDS].join(', ')}
Explicit-only: ${TARGETS.filter((t) => t.explicitOnly).map((t) => t.id).join(', ') || '(none)'}  (never auto-installed; pass via --target= or --all)`);
}

function detect(target) {
  return existsSync(target.detectPath);
}

function resolveTargets(parsed) {
  let chosen;
  if (parsed.explicit) {
    chosen = TARGETS.filter((t) => parsed.explicit.has(t.id));
  } else if (parsed.all) {
    chosen = [...TARGETS];
  } else {
    chosen = TARGETS.filter((t) => !t.explicitOnly && (t.defaultOn || detect(t)));
  }
  chosen = chosen.filter((t) => !parsed.excludes.has(t.id));
  return chosen;
}

function listTargets() {
  log('Known targets:\n');
  const w = Math.max(...TARGETS.map((t) => t.id.length));
  const lw = Math.max(...TARGETS.map((t) => t.label.length));
  for (const t of TARGETS) {
    const state = detect(t) ? 'detected' : 'not detected';
    const policy = t.explicitOnly ? 'explicit-only' : (t.defaultOn ? 'default-on' : 'detect-only');
    log(`  ${t.id.padEnd(w)}  ${t.label.padEnd(lw)}  [${state}]  ${policy}`);
    log(`  ${' '.repeat(w)}    skill: ${t.skillDir}`);
    if (t.settingsPath) log(`  ${' '.repeat(w)}    settings: ${t.settingsPath}`);
  }
}

function uninstallAll() {
  log('Removing codex-image-gen install...');
  let removed = 0;
  if (existsSync(INSTALL_DIR)) {
    rmSync(INSTALL_DIR, { recursive: true, force: true });
    log(`  [ok] removed ${INSTALL_DIR}`);
    removed++;
  } else {
    log(`  [skip] install dir not present at ${INSTALL_DIR}`);
  }
  for (const t of TARGETS) {
    if (existsSync(t.skillDir)) {
      rmSync(t.skillDir, { recursive: true, force: true });
      log(`  [ok] removed ${t.skillDir}  (${t.label})`);
      removed++;
    }
  }
  log(`\nDone. Removed ${removed} ${removed === 1 ? 'directory' : 'directories'}.`);
  log('(Settings files are left untouched — remove any matching');
  log('"Bash(node .../codex-image-gen.mjs *)" allow rules manually if you want them gone.)');
}

function install(parsed) {
  log('codex-image-gen installer');
  log('=========================\n');

  // ---- Phase 1: pre-flight checks (no filesystem mutations) ----
  log('[1/4] Pre-flight checks');
  const nodeVer = getVersion('node');
  if (!nodeVer) {
    err('node not found on PATH.');
    warn('  Install Node 18+ from https://nodejs.org and re-run.');
    process.exit(1);
  }
  log(`  [ok] node ${nodeVer}`);

  const codexVer = getVersion('codex');
  if (!codexVer) {
    err('codex CLI not found on PATH.');
    warn('  Install from https://github.com/openai/codex, then run: codex login');
    process.exit(1);
  }
  log(`  [ok] codex ${codexVer.split('\n')[0]}`);

  const skillTemplatePath = join(SCRIPT_DIR, 'SKILL.md');
  if (!existsSync(skillTemplatePath)) {
    err(`SKILL.md template not found at ${skillTemplatePath}`);
    warn('  The installer must run from a complete checkout/extract of the');
    warn('  codex-image-gen repo (the SKILL.md template lives next to install.mjs).');
    process.exit(1);
  }
  log(`  [ok] SKILL.md template found`);

  const toolSrc = join(SCRIPT_DIR, 'codex-image-gen.mjs');
  if (!existsSync(toolSrc)) {
    err(`runtime tool not found at ${toolSrc}`);
    warn('  codex-image-gen.mjs must live next to install.mjs in the same dir.');
    process.exit(1);
  }
  log(`  [ok] runtime tool found`);

  // ---- Phase 2: resolve target set ----
  log('\n[2/4] Resolve install targets');
  const targets = resolveTargets(parsed);
  if (targets.length === 0) {
    err('No install targets selected.');
    if (parsed.explicit) {
      warn('  --target= and --no-* combine to leave the resulting set empty.');
    } else {
      warn(`  None of the auto-detect targets were found, and --all was not passed.`);
      warn(`  Try one of:`);
      warn(`    --all                       install to every known target`);
      warn(`    --target=<id>[,<id>...]     known targets: ${[...KNOWN_IDS].join(', ')}`);
    }
    process.exit(1);
  }
  for (const t of targets) {
    const tag = detect(t) ? 'detected' : (t.defaultOn ? 'default-on' : 'forced');
    log(`  [ok] ${t.label.padEnd(22)} (${tag})`);
  }
  warnDuplicates(targets);

  // ---- Phase 3: copy the runtime tool to the shared install dir ----
  log(`\n[3/4] Copy runtime tool to ${INSTALL_DIR}`);
  mkdirSync(INSTALL_DIR, { recursive: true });
  // codex-image-gen.mjs is required (verified above), README.md is optional.
  copyFileSync(toolSrc, join(INSTALL_DIR, 'codex-image-gen.mjs'));
  log(`  [ok] codex-image-gen.mjs`);
  const readmeSrc = join(SCRIPT_DIR, 'README.md');
  if (existsSync(readmeSrc)) {
    copyFileSync(readmeSrc, join(INSTALL_DIR, 'README.md'));
    log(`  [ok] README.md`);
  } else {
    log(`  [skip] README.md not in source dir`);
  }

  // ---- Phase 4: render + drop SKILL.md into each target ----
  // Use the function form of String.replace so a literal `$` in the install
  // path (legal in usernames on Windows) isn't interpreted as a $&/$1/$$
  // backreference and silently mangled.
  const template = readFileSync(skillTemplatePath, 'utf8');
  const posixInstallDir = INSTALL_DIR.replace(/\\/g, '/');
  const scriptPath = `${posixInstallDir}/codex-image-gen.mjs`;
  const rendered = template
    .replace(/<<INSTALL_PATH>>/g, () => posixInstallDir)
    .replace(/<<SCRIPT_PATH>>/g, () => scriptPath);
  // Sanity check: every placeholder should be resolved. If the template ever
  // grows a new placeholder we forgot to render, we'd write a half-rendered
  // skill — surface that loudly instead of silently shipping it.
  const leftover = rendered.match(/<<[A-Z_]+>>/);
  if (leftover) {
    err(`SKILL.md template has unresolved placeholder: ${leftover[0]}`);
    warn('  The installer needs to be updated to render this placeholder.');
    process.exit(1);
  }

  // Note about Claude's `permissions.allow` glob: if INSTALL_DIR happens to
  // contain spaces (rare but possible — e.g. HOME=C:\Users\Some User), Claude
  // Code may not match this rule against the literal command string at runtime
  // since it'll quote the path. Known limitation; can be worked around manually
  // by editing settings.json if it bites.
  const allowRule = `Bash(node ${scriptPath} *)`;
  const failedPatchTargets = [];
  const installedTargets = [];

  log('\n[4/4] Install skill into target harnesses');
  for (const t of targets) {
    log(`\n--- ${t.label} ---`);
    const skillFile = join(t.skillDir, 'SKILL.md');
    const action = existsSync(skillFile) ? 'updated' : 'installed';
    mkdirSync(t.skillDir, { recursive: true });
    writeFileSync(skillFile, rendered);
    log(`  [ok] skill ${action} at ${skillFile}`);

    if (t.settingsPath) {
      const ok = patchSettings(t.settingsPath, allowRule);
      if (!ok) failedPatchTargets.push(t);
    } else {
      log(`  [ok] ${t.label} permits external commands by default; no settings patch needed`);
    }
    installedTargets.push(t);
  }

  // ---- Summary + next-step guidance ----
  log('\n=========================');
  log(`Installation complete: ${installedTargets.length}/${installedTargets.length} target(s) installed.`);
  if (failedPatchTargets.length) {
    // Soft-failure guidance — stays on stdout so it travels with the rest of
    // the install log. The install itself still exits 0 since the user can
    // add the rule manually.
    log(`Settings patch failed for ${failedPatchTargets.length} target(s) — see below.\n`);
    for (const t of failedPatchTargets) {
      log(`Could not auto-patch ${t.settingsPath}. Add this entry to the "permissions.allow"`);
      log(`array manually:`);
      log(`  "${allowRule}"\n`);
    }
  }
  log('\nSmoke test:');
  log(`  node ${scriptPath} --help\n`);
  log('First real run (uses ChatGPT subscription quota; ~30-60s for one image):');
  log(`  node ${scriptPath} \\`);
  log('    --style "photorealistic studio product photo" \\');
  log('    --subject "a red apple on white background"\n');
  log(`Note: each project that calls the tool will create a .codex-image-gen-tmp/`);
  log(`directory in its working directory. Add it to that project's .gitignore.`);
}

/**
 * If both ~/.agents/ AND a per-harness path that reads ~/.agents/skills/ are
 * being installed in the same run, the same skill ends up in two locations
 * Cursor / opencode both index — the user will see duplicate entries. Warn
 * loudly so they know to dedupe with --no-<id>.
 */
function warnDuplicates(targets) {
  const ids = new Set(targets.map((t) => t.id));
  if (!ids.has('agents')) return;
  const overlapping = ['cursor', 'opencode'].filter((id) => ids.has(id));
  if (overlapping.length) {
    warn(`  [warn] both 'agents' and ${overlapping.map((id) => `'${id}'`).join(' / ')} selected.`);
    warn(`         These harnesses read ~/.agents/skills/ in addition to their own dirs,`);
    warn(`         so the skill will appear twice. Pass ${overlapping.map((id) => `--no-${id}`).join(' ')} to dedupe.`);
  }
}

/**
 * Idempotently add an allow rule to ~/.claude/settings.json's permissions.allow.
 * Returns true on success (or no-op), false if we couldn't patch (caller prints
 * the rule for the user to add manually).
 */
function patchSettings(settingsPath, allowRule) {
  let settings = {};
  let existed = false;
  if (existsSync(settingsPath)) {
    existed = true;
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      log(`  [skip] could not parse ${settingsPath} (${e.message}); will print rule.`);
      return false;
    }
  }
  if (typeof settings !== 'object' || settings === null) {
    log(`  [skip] ${settingsPath} is not a JSON object; will print rule.`);
    return false;
  }
  if (!settings.permissions || typeof settings.permissions !== 'object') {
    settings.permissions = {};
  }
  if (!Array.isArray(settings.permissions.allow)) {
    settings.permissions.allow = [];
  }
  if (settings.permissions.allow.includes(allowRule)) {
    log(`  [ok] allow rule already present in ${settingsPath}`);
    return true;
  }
  settings.permissions.allow.push(allowRule);
  mkdirSync(dirname(settingsPath), { recursive: true });
  // Atomic write: temp + rename. If we crash mid-write, the user's existing
  // settings.json is untouched rather than half-overwritten.
  const tmpPath = `${settingsPath}.tmp-${process.pid}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n');
    renameSync(tmpPath, settingsPath);
  } catch (e) {
    // Most likely cause on Windows: the target file is held with an exclusive
    // write lock by a running Claude Code instance. Cleanup the temp file we
    // wrote so we don't leak it, and let the caller print the rule.
    try { rmSync(tmpPath, { force: true }); } catch { /* best-effort */ }
    log(`  [skip] could not write ${settingsPath} (${e.message}); will print rule.`);
    log(`         (Common cause on Windows: Claude Code is running and has the file locked.`);
    log(`          Quit Claude Code and re-run, or add the rule manually.)`);
    return false;
  }
  log(`  [ok] allow rule added to ${settingsPath}${existed ? '' : ' (new file)'}`);
  return true;
}

// Top-level dispatch: wrap so unexpected exceptions surface as clean errors
// (with the underlying message) rather than as raw stack traces.
try {
  const parsed = parseArgs(args);
  if (parsed.help) {
    printHelp();
  } else if (parsed.listTargets) {
    listTargets();
  } else if (parsed.uninstall) {
    uninstallAll();
  } else {
    install(parsed);
  }
} catch (e) {
  err(`unexpected failure: ${e.message}`);
  if (process.env.CIG_INSTALL_DEBUG) {
    warn(e.stack);
  } else {
    warn('  Re-run with CIG_INSTALL_DEBUG=1 for a stack trace.');
  }
  process.exit(1);
}
