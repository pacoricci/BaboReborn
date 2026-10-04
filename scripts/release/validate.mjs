import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

try {
  const tag = process.argv[2];
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? '')) {
    throw new Error('Expected a stable tag vMAJOR.MINOR.PATCH.');
  }
  const version = tag.slice(1);
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  if ([manifest.version, lock.version, lock.packages?.['']?.version].some((v) => v !== version)) {
    throw new Error('Release tag must match package.json and package-lock.json versions.');
  }
  const ref = `refs/tags/${tag}`;
  if (git('cat-file', '-t', ref) !== 'tag') {
    throw new Error('Release tags must be annotated: git tag -a.');
  }
  if (git('rev-parse', `${ref}^{commit}`) !== git('rev-parse', 'HEAD')) {
    throw new Error('Check out the tagged commit before validating a release.');
  }
  // A full fetch is required: local branch names are not evidence of inclusion.
  git('merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/main');
  if (!readFileSync(`docs/releases/${version}.md`, 'utf8').trim()) {
    throw new Error('Release notes must not be empty.');
  }
  console.log(`Validated ${tag} at ${git('rev-parse', 'HEAD')} on origin/main.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
