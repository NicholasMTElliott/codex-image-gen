#!/usr/bin/env node
/**
 * codex-image-gen installer
 *
 * Copies the tool to ~/.codex-image-gen/ and registers a Claude Code skill
 * at ~/.claude/skills/codex-image-gen/SKILL.md with the install path baked in.
 *
 * Usage:
 *   node install.mjs           # install
 *   node install.mjs --uninstall   # remove tool + skill
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
const SKILL_DIR = join(HOME, '.claude', 'skills', 'codex-image-gen');
const SETTINGS_PATH = join(HOME, '.claude', 'settings.json');

const args = process.argv.slice(2);
const uninstall = args.includes('--uninstall');

function log(msg) {
  process.stdout.write(msg + '\n');
}

function err(msg) {
  process.stderr.write('ERROR: ' + msg + '\n');
}

function checkCommand(cmd) {
  try {
    execSync(`${cmd} --version`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function uninstallAll() {
  log('Removing codex-image-gen install...');
  if (existsSync(INSTALL_DIR)) {
    rmSync(INSTALL_DIR, { recursive: true, force: true });
    log(`  removed ${INSTALL_DIR}`);
  }
  if (existsSync(SKILL_DIR)) {
    rmSync(SKILL_DIR, { recursive: true, force: true });
    log(`  removed ${SKILL_DIR}`);
  }
  log('\nDone. (Any matching entry in ~/.claude/settings.json was left in place — remove it manually.)');
}

function install() {
  log('codex-image-gen installer');
  log('=========================\n');

  if (!checkCommand('node')) {
    err('node not found on PATH. Install Node 18+ from https://nodejs.org');
    process.exit(1);
  }
  if (!checkCommand('codex')) {
    err('codex CLI not found on PATH.');
    err('  Install from https://github.com/openai/codex, then run: codex login');
    process.exit(1);
  }
  log('  [ok] node found');
  log('  [ok] codex found\n');

  // Copy tool
  mkdirSync(INSTALL_DIR, { recursive: true });
  const toCopy = ['codex-image-gen.mjs', 'README.md'];
  for (const f of toCopy) {
    const src = join(SCRIPT_DIR, f);
    if (existsSync(src)) {
      copyFileSync(src, join(INSTALL_DIR, f));
    }
  }
  log(`  [ok] tool copied to ${INSTALL_DIR}`);

  // Render and install SKILL.md with install path baked in
  mkdirSync(SKILL_DIR, { recursive: true });
  const skillTemplatePath = join(SCRIPT_DIR, 'SKILL.md');
  if (!existsSync(skillTemplatePath)) {
    err(`SKILL.md template not found at ${skillTemplatePath}`);
    process.exit(1);
  }
  const template = readFileSync(skillTemplatePath, 'utf8');
  const posixInstallDir = INSTALL_DIR.replace(/\\/g, '/');
  const scriptPath = `${posixInstallDir}/codex-image-gen.mjs`;
  const rendered = template
    .replace(/<<INSTALL_PATH>>/g, posixInstallDir)
    .replace(/<<SCRIPT_PATH>>/g, scriptPath);
  writeFileSync(join(SKILL_DIR, 'SKILL.md'), rendered);
  log(`  [ok] skill installed to ${SKILL_DIR}/SKILL.md\n`);

  // Auto-patch user-scope settings.json (best-effort, safe fallback)
  const allowRule = `Bash(node ${scriptPath} *)`;
  const patched = patchSettings(allowRule);

  log('\nInstallation complete.\n');
  if (!patched) {
    log('Could not auto-patch settings.json. Add this entry to the "permissions.allow"');
    log(`array in ${SETTINGS_PATH} manually:\n`);
    log(`  "${allowRule}"\n`);
  }
  log('Smoke test:');
  log(`  node ${scriptPath} --help\n`);
  log('First real run (will use ChatGPT subscription quota; ~30-60s for one image):');
  log(`  node ${scriptPath} \\`);
  log('    --style "photorealistic studio product photo" \\');
  log('    --subject "a red apple on white background"\n');
  log(`Note: each project that calls the tool will create a .codex-image-gen-tmp/`);
  log('directory in its working directory. Add it to that project\'s .gitignore.');
}

function patchSettings(allowRule) {
  let settings = {};
  let existed = false;
  if (existsSync(SETTINGS_PATH)) {
    existed = true;
    try {
      settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    } catch (e) {
      log(`  [skip] could not parse ${SETTINGS_PATH} (${e.message}); will print rule.`);
      return false;
    }
  }
  if (typeof settings !== 'object' || settings === null) {
    log(`  [skip] ${SETTINGS_PATH} is not a JSON object; will print rule.`);
    return false;
  }
  if (!settings.permissions || typeof settings.permissions !== 'object') {
    settings.permissions = {};
  }
  if (!Array.isArray(settings.permissions.allow)) {
    settings.permissions.allow = [];
  }
  if (settings.permissions.allow.includes(allowRule)) {
    log(`  [ok] allow rule already present in ${SETTINGS_PATH}`);
    return true;
  }
  settings.permissions.allow.push(allowRule);
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  // Atomic write: temp + rename. If we crash mid-write, the user's existing
  // settings.json is untouched rather than half-overwritten.
  const tmpPath = `${SETTINGS_PATH}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n');
  renameSync(tmpPath, SETTINGS_PATH);
  log(`  [ok] allow rule added to ${SETTINGS_PATH}${existed ? '' : ' (new file)'}`);
  return true;
}

if (uninstall) {
  uninstallAll();
} else {
  install();
}
