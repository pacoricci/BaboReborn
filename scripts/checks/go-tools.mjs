// Keep development tools out of the game module and the global executable path.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tools = {
  lint: {
    module: 'github.com/golangci/golangci-lint/v2/cmd/golangci-lint',
    version: 'v2.13.2',
    name: 'golangci-lint',
  },
  vuln: { module: 'golang.org/x/vuln/cmd/govulncheck', version: 'v1.7.0', name: 'govulncheck' },
};
const directory = (tool) => join(root, 'output', 'tools', `${tool.name}-${tool.version}`);
const executable = (tool) =>
  join(directory(tool), tool.name + (process.platform === 'win32' ? '.exe' : ''));
const run = (file, args, env = process.env) =>
  execFileSync(file, args, { cwd: root, env, stdio: 'inherit' });
try {
  switch (process.argv[2]) {
    case 'install':
      for (const tool of Object.values(tools)) {
        mkdirSync(directory(tool), { recursive: true });
        run('go', ['install', `${tool.module}@${tool.version}`], {
          ...process.env,
          GOBIN: directory(tool),
        });
      }
      break;
    case 'lint':
      run(executable(tools.lint), ['run', './...']);
      break;
    case 'format-check': {
      // golangci-lint may report formatting differences with a successful exit.
      const diff = execFileSync(
        executable(tools.lint),
        ['fmt', '--diff', ...process.argv.slice(3)],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
      );
      if (diff.trim()) {
        process.stdout.write(diff);
        process.exitCode = 1;
      }
      break;
    }
    case 'format':
      run(executable(tools.lint), ['fmt']);
      break;
    case 'vuln':
      run(executable(tools.vuln), ['./...']);
      break;
    default:
      throw new Error('Expected install, lint, format-check, format or vuln.');
  }
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout);
  if (error.code === 'ENOENT') console.error('Missing Go tools. Run make tools-install first.');
  else console.error(error.message);
  process.exitCode = error.status || 1;
}
