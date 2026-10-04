import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

try {
  const tag = process.argv[2];
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? '')) {
    throw new Error('Expected a stable tag vMAJOR.MINOR.PATCH.');
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
  console.log(`Validated ${tag} at ${git('rev-parse', 'HEAD')} on origin/main.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
