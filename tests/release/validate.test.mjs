import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const validator = fileURLToPath(new URL('../../scripts/release/validate.mjs', import.meta.url));

function fixture(t, version = '0.1.0') {
  const cwd = mkdtempSync(join(tmpdir(), 'baboreborn-release-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'release@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ version }));
  const lock = { version, packages: { '': { version } } };
  writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify(lock));
  mkdirSync(join(cwd, 'docs/releases'), { recursive: true });
  writeFileSync(join(cwd, `docs/releases/${version}.md`), 'Initial release.\n');
  git('add', '.');
  git('commit', '-m', 'Initial release');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const tag = () => git('tag', '-a', `v${version}`, '-m', `Release ${version}`);
  const run = (name = `v${version}`) =>
    spawnSync(process.execPath, [validator, name], { cwd, encoding: 'utf8' });
  return { cwd, git, tag, run, lock };
}

test('accepts an annotated stable tag included in main, even after main advances', (t) => {
  const f = fixture(t);
  f.tag();
  f.git('commit', '--allow-empty', '-m', 'Next change');
  f.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  f.git('checkout', '--detach', 'v0.1.0');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
});

test('rejects prerelease and malformed tags', (t) => {
  const f = fixture(t);
  for (const name of [
    'v1.0.0-alpha.1',
    'v1.0.0-beta.1',
    'v0.01.0',
    'v01.0.0',
    'v1.0',
    '1.0.0',
    'v1.0.0+build',
  ]) {
    assert.match(f.run(name).stderr, /Expected a stable tag/);
  }
});

test('rejects a tag on an unmerged commit', (t) => {
  const f = fixture(t);
  f.git('checkout', '-b', 'feature/unmerged');
  f.git('commit', '--allow-empty', '-m', 'Unmerged change');
  f.tag();
  assert.notEqual(f.run().status, 0);
});

test('rejects a lightweight tag', (t) => {
  const f = fixture(t);
  f.git('tag', 'v0.1.0');
  assert.match(f.run().stderr, /must be annotated/);
});

test('rejects validation from a different commit', (t) => {
  const f = fixture(t);
  f.tag();
  f.git('commit', '--allow-empty', '-m', 'Different commit');
  assert.match(f.run().stderr, /Check out the tagged commit/);
});

test('rejects drift in the manifest and both lockfile version fields', (t) => {
  const f = fixture(t);
  f.tag();
  writeFileSync(join(f.cwd, 'package.json'), JSON.stringify({ version: '1.0.1' }));
  assert.match(f.run().stderr, /must match/);
  f.git('checkout', '--', 'package.json');
  for (const lock of [
    { ...f.lock, version: '1.0.1' },
    { ...f.lock, packages: { '': { version: '1.0.1' } } },
  ]) {
    writeFileSync(join(f.cwd, 'package-lock.json'), JSON.stringify(lock));
    assert.match(f.run().stderr, /must match/);
  }
});

test('requires origin/main and nonempty release notes', (t) => {
  const f = fixture(t);
  f.tag();
  f.git('update-ref', '-d', 'refs/remotes/origin/main');
  assert.notEqual(f.run().status, 0);
  f.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  writeFileSync(join(f.cwd, 'docs/releases/0.1.0.md'), ' \n');
  assert.match(f.run().stderr, /must not be empty/);
  rmSync(join(f.cwd, 'docs/releases/0.1.0.md'));
  assert.notEqual(f.run().status, 0);
});

test('continues to accept releases with a nonzero major', (t) => {
  const f = fixture(t, '1.0.0');
  f.tag();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
});
