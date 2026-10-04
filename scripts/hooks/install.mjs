import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../../', import.meta.url));
const result = spawnSync('git', ['config', '--get-all', 'core.hooksPath'], {
  cwd,
  encoding: 'utf8',
});
if (result.error) throw result.error;
if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr);
const current = result.stdout;
if (current.trim() && current.trim() !== '.githooks') {
  throw new Error(
    `Existing core.hooksPath must be reviewed before installation: ${current.trim()}`,
  );
}
execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd });
console.log('Installed game hooks. Run make precommit to check staged changes.');
