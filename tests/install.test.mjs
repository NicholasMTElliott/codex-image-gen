import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mktempDir, runInstaller } from './helpers.mjs';

function paths(home) {
  return {
    installDir: join(home, '.codex-image-gen'),
    skillDir: join(home, '.claude', 'skills', 'codex-image-gen'),
    settingsPath: join(home, '.claude', 'settings.json'),
    skillFile: join(home, '.claude', 'skills', 'codex-image-gen', 'SKILL.md'),
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
