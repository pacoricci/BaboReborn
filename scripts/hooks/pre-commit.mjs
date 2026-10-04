import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
let snapshot;
try {
  git(['diff', '--cached', '--check']);
  const changed = git(['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean);
  if (changed.length === 0) process.exit(0);
  const files = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
    .split('\0')
    .filter(Boolean);
  // Export the index, never stash or rewrite the user's partially staged files.
  snapshot = mkdtempSync(join(tmpdir(), 'baboreborn-precommit-'));
  git(['checkout-index', '--all', `--prefix=${snapshot}${sep}`]);
  const link = (path) => {
    const destination = join(snapshot, path);
    mkdirSync(join(destination, '..'), { recursive: true });
    symlinkSync(join(root, path), destination, process.platform === 'win32' ? 'junction' : 'dir');
  };
  link('node_modules');
  const run = (script, args) =>
    execFileSync(process.execPath, [join(snapshot, script), ...args], {
      cwd: snapshot,
      stdio: 'inherit',
    });
  // API file discovery respects the staged ignore file and avoids CLI glob expansion.
  const prettier = await import(join(root, 'node_modules/prettier/index.mjs'));
  const formatted = [];
  for (const file of files) {
    const info = await prettier.getFileInfo(join(snapshot, file), {
      ignorePath: join(snapshot, '.prettierignore'),
    });
    if (!info.ignored && info.inferredParser) formatted.push(`./${file}`);
  }
  if (formatted.length) run('node_modules/prettier/bin/prettier.cjs', ['--check', ...formatted]);
  const scripts = files.filter((file) => /\.(ts|tsx|js|mjs)$/.test(file));
  if (scripts.length) {
    link('scripts/checks/node_modules');
    run('scripts/checks/node_modules/eslint/bin/eslint.js', [
      '--config',
      'scripts/checks/eslint.config.mjs',
      '--max-warnings',
      '0',
      '--no-warn-ignored',
      ...scripts.map((file) => `./${file}`),
    ]);
  }
  if (
    changed.some(
      (file) =>
        /\.tsx?$/.test(file) ||
        /(^|\/)tsconfig[^/]*\.json$/.test(file) ||
        /(^|\/)package(-lock)?\.json$/.test(file),
    )
  ) {
    run('node_modules/typescript/bin/tsc', ['--noEmit']);
    run('node_modules/typescript/bin/tsc', ['-p', 'scripts/checks/typescript/tsconfig.tools.json']);
  }
  const go = files.filter((file) => file.endsWith('.go'));
  if (go.length) {
    link('output/tools');
    run('scripts/checks/go-tools.mjs', ['format-check', ...go.map((file) => `./${file}`)]);
  }
  // Tests catch cross-package regressions that formatting and types cannot.
  // The race detector and the remaining integration gates stay in make check.
  const code = changed.some((file) => !file.endsWith('.md'));
  const goInputs = changed.some((file) => /^(backend|content)\/|^go\.(mod|sum)$/.test(file));
  if (code) {
    // Go embeds the frontend build, which is generated and never staged.
    for (const path of ['backend/web/dist', 'backend/web/portal']) {
      if (!existsSync(join(root, path))) {
        throw new Error('Missing embedded frontend. Run make build-embedded first.');
      }
      cpSync(join(root, path), join(snapshot, path), { recursive: true });
    }
    const test = (file, args) => {
      console.log(`Running ${[file, ...args].join(' ')}…`);
      // Output is shown only on failure; Windows needs a shell to start npm.
      execFileSync(file, args, {
        cwd: snapshot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    };
    test('npm', ['test']);
    // -trimpath lets Go reuse cached results across snapshot directories.
    if (goInputs) test('go', ['test', '-trimpath', './...']);
  }
  console.log('Staged checks passed.');
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout);
  console.error('Pre-commit failed. Fix the reported errors and stage the changes again.');
  if (error.code === 'ENOENT' || error.code === 'ERR_MODULE_NOT_FOUND') {
    console.error('Install dependencies with npm ci and make tools-install.');
  }
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (snapshot) rmSync(snapshot, { recursive: true, force: true });
}
