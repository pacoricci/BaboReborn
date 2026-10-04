import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  git('commit', '--allow-empty', '-m', 'Initial release');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const tag = () => git('tag', '-a', `v${version}`, '-m', `Release ${version}`);
  const run = (name = `v${version}`) =>
    spawnSync(process.execPath, [validator, name], { cwd, encoding: 'utf8' });
  return { cwd, git, tag, run };
}

test('accepts an annotated stable tag without notes, even after main advances', (t) => {
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

test('accepts a release independently of npm manifest versions', (t) => {
  const f = fixture(t, '2.3.4');
  writeFileSync(join(f.cwd, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  writeFileSync(
    join(f.cwd, 'package-lock.json'),
    JSON.stringify({ version: '0.1.0', packages: { '': { version: '0.1.0' } } }),
  );
  f.git('add', '.');
  f.git('commit', '-m', 'Unrelated npm package version');
  f.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  f.tag();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
});

test('requires origin/main', (t) => {
  const f = fixture(t);
  f.tag();
  f.git('update-ref', '-d', 'refs/remotes/origin/main');
  assert.notEqual(f.run().status, 0);
});

test('continues to accept releases with a nonzero major', (t) => {
  const f = fixture(t, '1.0.0');
  f.tag();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
});
