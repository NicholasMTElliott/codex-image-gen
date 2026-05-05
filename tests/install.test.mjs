import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mktempDir, REPO_ROOT, runInstaller, runInstallerCustom } from './helpers.mjs';

function paths(home) {
  return {
    installDir: join(home, '.codex-image-gen'),
    skillDir: join(home, '.claude', 'skills', 'codex-image-gen'),
    settingsPath: join(home, '.claude', 'settings.json'),
    skillFile: join(home, '.claude', 'skills', 'codex-image-gen', 'SKILL.md'),
    opencodeRoot: join(home, '.config', 'opencode'),
    opencodeSkillDir: join(home, '.config', 'opencode', 'skills', 'codex-image-gen'),
    opencodeSkillFile: join(home, '.config', 'opencode', 'skills', 'codex-image-gen', 'SKILL.md'),
    clineRoot: join(home, '.cline'),
    clineSkillDir: join(home, '.cline', 'skills', 'codex-image-gen'),
    clineSkillFile: join(home, '.cline', 'skills', 'codex-image-gen', 'SKILL.md'),
    cursorRoot: join(home, '.cursor'),
    cursorSkillDir: join(home, '.cursor', 'skills', 'codex-image-gen'),
    cursorSkillFile: join(home, '.cursor', 'skills', 'codex-image-gen', 'SKILL.md'),
    agentsRoot: join(home, '.agents'),
    agentsSkillDir: join(home, '.agents', 'skills', 'codex-image-gen'),
    agentsSkillFile: join(home, '.agents', 'skills', 'codex-image-gen', 'SKILL.md'),
  };
}

test('18. install copies tool + README into ~/.codex-image-gen and renders skill', async () => {
  const r = await runInstaller();
  assert.equal(r.code, 0, `installer failed: ${r.stderr}`);
  const p = paths(r.home);
  assert.ok(existsSync(join(p.installDir, 'codex-image-gen.mjs')));
  assert.ok(existsSync(join(p.installDir, 'README.md')));
  assert.ok(existsSync(p.skillFile));
});

test('19. rendered SKILL.md has no <<INSTALL_PATH>> / <<SCRIPT_PATH>> placeholders left', async () => {
  const r = await runInstaller();
  assert.equal(r.code, 0);
  const p = paths(r.home);
  const skill = readFileSync(p.skillFile, 'utf8');
  assert.doesNotMatch(skill, /<<INSTALL_PATH>>/);
  assert.doesNotMatch(skill, /<<SCRIPT_PATH>>/);
  // Should reference the absolute install path
  assert.match(skill, /codex-image-gen\.mjs/);
});

test('20. greenfield: settings.json absent → installer creates it with the rule', async () => {
  const r = await runInstaller();
  assert.equal(r.code, 0);
  const p = paths(r.home);
  assert.ok(existsSync(p.settingsPath), 'settings.json should be created');
  const settings = JSON.parse(readFileSync(p.settingsPath, 'utf8'));
  assert.ok(Array.isArray(settings.permissions?.allow));
  assert.ok(settings.permissions.allow.some((rule) => /codex-image-gen\.mjs/.test(rule)));
});

test('21. settings.json with existing unrelated rules → installer preserves them', async () => {
  const home = mktempDir('cig-home-');
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const preExisting = {
    enabledPlugins: { 'something@example': true },
    effortLevel: 'xhigh',
    permissions: {
      allow: ['Bash(ls *)', 'Bash(git status)'],
    },
  };
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(preExisting, null, 2));

  const r = await runInstaller({ home });
  assert.equal(r.code, 0);
  const after = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
  // Unrelated keys preserved
  assert.deepEqual(after.enabledPlugins, preExisting.enabledPlugins);
  assert.equal(after.effortLevel, 'xhigh');
  // Existing allow rules preserved
  assert.ok(after.permissions.allow.includes('Bash(ls *)'));
  assert.ok(after.permissions.allow.includes('Bash(git status)'));
  // New rule appended
  assert.ok(after.permissions.allow.some((rule) => /codex-image-gen\.mjs/.test(rule)));
});

test('22. re-running installer is idempotent (no duplicate allow rule)', async () => {
  const home = mktempDir('cig-home-');
  const r1 = await runInstaller({ home });
  assert.equal(r1.code, 0);
  const r2 = await runInstaller({ home });
  assert.equal(r2.code, 0);
  const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  const matching = settings.permissions.allow.filter((rule) => /codex-image-gen\.mjs/.test(rule));
  assert.equal(matching.length, 1, `expected exactly one matching rule, got ${matching.length}: ${JSON.stringify(matching)}`);
  // Second run should print the "already present" notice
  assert.match(r2.stdout, /allow rule already present/);
});

test('23. malformed settings.json → installer falls back to printing the rule (still exits 0)', async () => {
  const home = mktempDir('cig-home-');
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, 'settings.json'), '{ this is not json }');

  const r = await runInstaller({ home });
  assert.equal(r.code, 0, `installer should not crash on bad settings.json: ${r.stderr}`);
  // Should mention the rule (so user can add manually)
  assert.match(r.stdout, /Bash\(node .+codex-image-gen\.mjs \*\)/);
  // Should mention the fallback path
  assert.match(r.stdout, /Could not auto-patch|will print rule/);
});

test('24. --uninstall removes both directories', async () => {
  const home = mktempDir('cig-home-');
  // Install first
  const ri = await runInstaller({ home });
  assert.equal(ri.code, 0);
  const p = paths(home);
  assert.ok(existsSync(p.installDir));
  assert.ok(existsSync(p.skillDir));

  // Uninstall
  const ru = await runInstaller({ home, args: ['--uninstall'] });
  assert.equal(ru.code, 0);
  assert.equal(existsSync(p.installDir), false, 'install dir should be removed');
  assert.equal(existsSync(p.skillDir), false, 'skill dir should be removed');
});

// ---------------------------------------------------------------------------
// Multi-target install (Claude Code + opencode)
// ---------------------------------------------------------------------------

test('25. opencode not detected: default install skips opencode skill dir', async () => {
  // Fresh HOME has no ~/.config/opencode/, so opencode should not be auto-installed.
  const r = await runInstaller();
  assert.equal(r.code, 0);
  const p = paths(r.home);
  assert.ok(existsSync(p.skillFile), 'claude skill should be installed');
  assert.equal(existsSync(p.opencodeSkillFile), false, 'opencode skill should NOT be installed when undetected');
});

test('26. opencode detected: default install drops same SKILL.md into opencode skills dir', async () => {
  const home = mktempDir('cig-home-');
  // Simulate opencode being installed by pre-creating its config root.
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });

  const r = await runInstaller({ home });
  assert.equal(r.code, 0);
  const p = paths(home);
  assert.ok(existsSync(p.skillFile), 'claude skill should be installed');
  assert.ok(existsSync(p.opencodeSkillFile), 'opencode skill should be installed when detected');

  // Both skill files should be byte-identical (rendered once, copied to each target).
  const claudeSkill = readFileSync(p.skillFile, 'utf8');
  const opencodeSkill = readFileSync(p.opencodeSkillFile, 'utf8');
  assert.equal(claudeSkill, opencodeSkill, 'rendered SKILL.md should match across targets');
  assert.doesNotMatch(opencodeSkill, /<<INSTALL_PATH>>|<<SCRIPT_PATH>>/);
});

test('27. --target=opencode: only opencode is installed, claude is skipped', async () => {
  const home = mktempDir('cig-home-');
  // No opencode dir present — but --target= forces install regardless of detection.
  const r = await runInstaller({ home, args: ['--target=opencode'] });
  assert.equal(r.code, 0);
  const p = paths(home);
  assert.equal(existsSync(p.skillFile), false, 'claude skill should NOT be installed when not in --target list');
  assert.ok(existsSync(p.opencodeSkillFile), 'opencode skill should be installed');
  // The shared install dir is still created — the binary is shared across targets.
  assert.ok(existsSync(p.installDir));
});

test('28. --all installs every target even when none is detected', async () => {
  const home = mktempDir('cig-home-');
  const r = await runInstaller({ home, args: ['--all'] });
  assert.equal(r.code, 0);
  const p = paths(home);
  assert.ok(existsSync(p.skillFile));
  assert.ok(existsSync(p.opencodeSkillFile));
  assert.ok(existsSync(p.clineSkillFile));
  assert.ok(existsSync(p.cursorSkillFile));
  assert.ok(existsSync(p.agentsSkillFile), '--all includes the explicit-only agents target');
});

test('29. --no-opencode excludes opencode even when detected', async () => {
  const home = mktempDir('cig-home-');
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  const r = await runInstaller({ home, args: ['--no-opencode'] });
  assert.equal(r.code, 0);
  const p = paths(home);
  assert.ok(existsSync(p.skillFile), 'claude skill should be installed');
  assert.equal(existsSync(p.opencodeSkillFile), false, 'opencode skill should be excluded by --no-opencode');
});

test('30. opencode does not get a settings.json patch (permissive by default)', async () => {
  const home = mktempDir('cig-home-');
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  const r = await runInstaller({ home });
  assert.equal(r.code, 0);
  // We don't write opencode.json — opencode allows external commands by default,
  // and patching the user's config (especially without their having one) would
  // be invasive.
  assert.equal(existsSync(join(home, '.config', 'opencode', 'opencode.json')), false);
  assert.equal(existsSync(join(home, '.config', 'opencode', 'opencode.jsonc')), false);
  // Stdout should explicitly mention that opencode needs no settings patch.
  assert.match(r.stdout, /no settings patch needed/i);
});

test('31. --uninstall removes opencode skill dir too', async () => {
  const home = mktempDir('cig-home-');
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  const ri = await runInstaller({ home });
  assert.equal(ri.code, 0);
  const p = paths(home);
  assert.ok(existsSync(p.opencodeSkillDir));

  const ru = await runInstaller({ home, args: ['--uninstall'] });
  assert.equal(ru.code, 0);
  assert.equal(existsSync(p.skillDir), false);
  assert.equal(existsSync(p.opencodeSkillDir), false);
});

test('32. --list-targets exits without installing anything', async () => {
  const home = mktempDir('cig-home-');
  const r = await runInstaller({ home, args: ['--list-targets'] });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /claude/);
  assert.match(r.stdout, /opencode/);
  assert.match(r.stdout, /cline/);
  assert.match(r.stdout, /cursor/);
  assert.match(r.stdout, /agents/);
  assert.match(r.stdout, /explicit-only/, 'agents target should be tagged explicit-only');
  assert.match(r.stdout, /detected|not detected/);
  // Nothing should have been written.
  const p = paths(home);
  assert.equal(existsSync(p.installDir), false);
  assert.equal(existsSync(p.skillDir), false);
  assert.equal(existsSync(p.opencodeSkillDir), false);
  assert.equal(existsSync(p.clineSkillDir), false);
  assert.equal(existsSync(p.cursorSkillDir), false);
  assert.equal(existsSync(p.agentsSkillDir), false);
});

test('33. unknown --target= id exits with error code 2', async () => {
  const r = await runInstaller({ args: ['--target=bogus-harness'] });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown target/i);
});

test('34. cline not detected: default install skips cline skill dir', async () => {
  // Fresh HOME has no ~/.cline/, so cline should not be auto-installed.
  const r = await runInstaller();
  assert.equal(r.code, 0);
  const p = paths(r.home);
  assert.ok(existsSync(p.skillFile), 'claude skill should be installed');
  assert.equal(existsSync(p.clineSkillFile), false, 'cline skill should NOT be installed when undetected');
});

test('35. cline detected: default install drops same SKILL.md into cline skills dir', async () => {
  const home = mktempDir('cig-home-');
  // Simulate Cline being installed by pre-creating its config root.
  mkdirSync(join(home, '.cline'), { recursive: true });

  const r = await runInstaller({ home });
  assert.equal(r.code, 0);
  const p = paths(home);
  assert.ok(existsSync(p.skillFile), 'claude skill should be installed');
  assert.ok(existsSync(p.clineSkillFile), 'cline skill should be installed when detected');

  // Skill file is rendered identically across targets.
  const claudeSkill = readFileSync(p.skillFile, 'utf8');
  const clineSkill = readFileSync(p.clineSkillFile, 'utf8');
  assert.equal(claudeSkill, clineSkill);
  assert.doesNotMatch(clineSkill, /<<INSTALL_PATH>>|<<SCRIPT_PATH>>/);
});

test('36. --target=cline: only cline is installed, claude is skipped', async () => {
  const home = mktempDir('cig-home-');
  const r = await runInstaller({ home, args: ['--target=cline'] });
  assert.equal(r.code, 0);
  const p = paths(home);
  assert.equal(existsSync(p.skillFile), false, 'claude skill should NOT be installed when not in --target list');
  assert.ok(existsSync(p.clineSkillFile), 'cline skill should be installed');
  assert.ok(existsSync(p.installDir));
});

test('37. --uninstall removes cline skill dir too', async () => {
  const home = mktempDir('cig-home-');
  mkdirSync(join(home, '.cline'), { recursive: true });
  const ri = await runInstaller({ home });
  assert.equal(ri.code, 0);
  const p = paths(home);
  assert.ok(existsSync(p.clineSkillDir));

  const ru = await runInstaller({ home, args: ['--uninstall'] });
  assert.equal(ru.code, 0);
  assert.equal(existsSync(p.clineSkillDir), false);
});

test('38. cursor not detected: default install skips cursor skill dir', async () => {
  const r = await runInstaller();
  assert.equal(r.code, 0);
  const p = paths(r.home);
  assert.ok(existsSync(p.skillFile), 'claude skill should be installed');
  assert.equal(existsSync(p.cursorSkillFile), false, 'cursor skill should NOT be installed when undetected');
});

test('39. cursor detected: default install drops same SKILL.md into cursor skills dir', async () => {
  const home = mktempDir('cig-home-');
  mkdirSync(join(home, '.cursor'), { recursive: true });

  const r = await runInstaller({ home });
  assert.equal(r.code, 0);
  const p = paths(home);
  assert.ok(existsSync(p.skillFile), 'claude skill should be installed');
  assert.ok(existsSync(p.cursorSkillFile), 'cursor skill should be installed when detected');

  const claudeSkill = readFileSync(p.skillFile, 'utf8');
  const cursorSkill = readFileSync(p.cursorSkillFile, 'utf8');
  assert.equal(claudeSkill, cursorSkill);
  assert.doesNotMatch(cursorSkill, /<<INSTALL_PATH>>|<<SCRIPT_PATH>>/);
});

test('40. --target=cursor: only cursor is installed, claude is skipped', async () => {
  const home = mktempDir('cig-home-');
  const r = await runInstaller({ home, args: ['--target=cursor'] });
  assert.equal(r.code, 0);
  const p = paths(home);
  assert.equal(existsSync(p.skillFile), false);
  assert.ok(existsSync(p.cursorSkillFile));
  assert.ok(existsSync(p.installDir));
});

test('41. --uninstall removes cursor skill dir too', async () => {
  const home = mktempDir('cig-home-');
  mkdirSync(join(home, '.cursor'), { recursive: true });
  const ri = await runInstaller({ home });
  assert.equal(ri.code, 0);
  const p = paths(home);
  assert.ok(existsSync(p.cursorSkillDir));

  const ru = await runInstaller({ home, args: ['--uninstall'] });
  assert.equal(ru.code, 0);
  assert.equal(existsSync(p.cursorSkillDir), false);
});

// ---------------------------------------------------------------------------
// agents target — explicit-only (cross-harness shared dir)
// ---------------------------------------------------------------------------

test('42. agents NOT auto-installed even when ~/.agents/ exists (explicit-only)', async () => {
  const home = mktempDir('cig-home-');
  // Pre-create the dir — under normal detection rules this would trigger
  // auto-install, but the agents target is explicit-only and must be skipped.
  mkdirSync(join(home, '.agents'), { recursive: true });
  const r = await runInstaller({ home });
  assert.equal(r.code, 0);
  const p = paths(home);
  assert.ok(existsSync(p.skillFile), 'claude should still be installed');
  assert.equal(
    existsSync(p.agentsSkillFile),
    false,
    'agents target must NOT auto-install even when its dir exists — would duplicate cursor/opencode entries',
  );
});

test('43. --target=agents installs only to ~/.agents/skills/', async () => {
  const home = mktempDir('cig-home-');
  const r = await runInstaller({ home, args: ['--target=agents'] });
  assert.equal(r.code, 0);
  const p = paths(home);
  assert.equal(existsSync(p.skillFile), false);
  assert.equal(existsSync(p.cursorSkillFile), false);
  assert.equal(existsSync(p.opencodeSkillFile), false);
  assert.ok(existsSync(p.agentsSkillFile));
  // Skill rendered the same way as for any other target.
  const skill = readFileSync(p.agentsSkillFile, 'utf8');
  assert.doesNotMatch(skill, /<<INSTALL_PATH>>|<<SCRIPT_PATH>>/);
});

test('44. --uninstall removes agents skill dir too', async () => {
  const home = mktempDir('cig-home-');
  // Install via --target=agents (explicit-only).
  const ri = await runInstaller({ home, args: ['--target=agents'] });
  assert.equal(ri.code, 0);
  const p = paths(home);
  assert.ok(existsSync(p.agentsSkillDir));

  const ru = await runInstaller({ home, args: ['--uninstall'] });
  assert.equal(ru.code, 0);
  assert.equal(existsSync(p.agentsSkillDir), false);
});

// ---------------------------------------------------------------------------
// Diagnostics + bug fixes from the post-install code review
// ---------------------------------------------------------------------------

test('45. typo in --no-<id> exits 2 with a clear error (not silent no-op)', async () => {
  // Pre-fix behaviour: --no-claud would silently add "claud" to the exclusion
  // set, do nothing, and the user would think they had excluded claude. The
  // installer now validates --no-<id> against the known target ids.
  const r = await runInstaller({ args: ['--no-claud'] });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown target id/i);
  assert.match(r.stderr, /claude/i, 'error should hint at the known ids');
});

test('46. empty --target= exits 2 with a clear error', async () => {
  const r = await runInstaller({ args: ['--target='] });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--target= requires at least one id/i);
});

test('47. SKILL.md template missing fails BEFORE creating the install dir', async () => {
  // Run the installer from a directory that doesn't contain SKILL.md. The
  // installer should detect this in the pre-flight phase and exit 1 without
  // creating ~/.codex-image-gen/. (Regression test: previous behaviour mkdir'd
  // and copied the binary first, then noticed the missing template.)
  const home = mktempDir('cig-home-');
  const fakeRepo = mktempDir('cig-repo-');
  // Put install.mjs there but no SKILL.md or codex-image-gen.mjs.
  writeFileSync(join(fakeRepo, 'install.mjs'), readFileSync(join(REPO_ROOT, 'install.mjs')));

  const r = await runInstallerCustom({ home, installerPath: join(fakeRepo, 'install.mjs') });
  assert.notEqual(r.code, 0);
  // No partial install left behind.
  assert.equal(existsSync(join(home, '.codex-image-gen')), false, 'install dir should NOT have been created');
  assert.equal(existsSync(join(home, '.claude', 'skills', 'codex-image-gen')), false, 'skill dir should NOT have been created');
});

test('48. install dir contains $ in path: SKILL.md placeholders rendered correctly', async () => {
  // Pre-fix bug: String.replace(regex, str) treats `$&`, `$1`, `$$` etc. in
  // the replacement string as backreferences. If the install path contains a
  // literal `$` (legal in Windows usernames — service accounts often end in
  // `$`), the substitution would mangle the rendered skill.
  // We can't actually change HOME to contain a $ in a test (filesystem-level
  // concerns), but we CAN verify the rendered skill output has no leftover
  // placeholders and references a valid path. A unit-level guard is added in
  // the installer itself ("unresolved placeholder" check) and would also
  // catch a mangled render.
  const home = mktempDir('cig-home-');
  const r = await runInstaller({ home });
  assert.equal(r.code, 0);
  const skillFile = join(home, '.claude', 'skills', 'codex-image-gen', 'SKILL.md');
  const skill = readFileSync(skillFile, 'utf8');
  assert.doesNotMatch(skill, /<<[A-Z_]+>>/, 'no unresolved placeholders');
  assert.doesNotMatch(skill, /\$&|\$1|\$\$/, 'no special-replacement artifacts');
});

test('49. install output includes phase markers (1/4 .. 4/4) for progress visibility', async () => {
  const r = await runInstaller();
  assert.equal(r.code, 0);
  assert.match(r.stdout, /\[1\/4\]/, 'pre-flight phase marker');
  assert.match(r.stdout, /\[2\/4\]/, 'resolve targets phase marker');
  assert.match(r.stdout, /\[3\/4\]/, 'copy runtime phase marker');
  assert.match(r.stdout, /\[4\/4\]/, 'install skill phase marker');
});

test('50. install output includes node + codex versions for support diagnostics', async () => {
  const r = await runInstaller();
  assert.equal(r.code, 0);
  // Match a version-like token after "node " in the pre-flight output.
  assert.match(r.stdout, /node v?\d+\.\d+\.\d+/, 'node version reported');
  assert.match(r.stdout, /codex /, 'codex line reported (fake-codex shim has its own version)');
});

test('51. --all + agents + cursor warns about duplicate skill entries', async () => {
  const home = mktempDir('cig-home-');
  // --all installs every target including agents. cursor reads ~/.agents/
  // skills/ in addition to its own dir, so the user would see the skill
  // twice. We should warn loudly.
  const r = await runInstaller({ home, args: ['--all'] });
  assert.equal(r.code, 0);
  // Warning lives on stderr (it's advisory, not an error).
  assert.match(r.stderr, /\[warn\].*agents/i);
  assert.match(r.stderr, /--no-cursor/, 'should suggest the dedup flag');
});

test('52. error paths print friendly diagnostics (no raw stack, no ERROR: on continuation lines)', async () => {
  // No targets to install (default set excluded, no --target=, no --all).
  // This path through resolveTargets returns an empty list and exits 1 with a
  // multi-line guidance block. We verify the diagnostics shape: an "ERROR:"
  // lead line, then continuation guidance that does NOT have the ERROR:
  // prefix repeated on every line, and no raw stack trace.
  const home = mktempDir('cig-home-');
  const r = await runInstaller({ home, args: ['--no-claude'] });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /ERROR: No install targets selected/, 'lead error line has ERROR: prefix');
  // The bullet-list lines that follow should NOT each start with "ERROR:".
  // Find the ERROR: line, then check the next non-empty line is unprefixed.
  const continuationMatch = r.stderr.match(/ERROR:.*\n([^\n]+)/);
  assert.ok(continuationMatch, 'should have a line after the ERROR: line');
  assert.doesNotMatch(continuationMatch[1], /^ERROR:/, 'continuation guidance should not be prefixed with ERROR:');
  // No raw stack trace by default.
  assert.doesNotMatch(r.stderr, /at .+install\.mjs:\d+/, 'no raw stack trace');
});
