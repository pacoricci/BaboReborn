import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const directory = resolve('output/tools/protobuf');
mkdirSync(directory, { recursive: true });
const run = (command, args, env = process.env) =>
  execFileSync(command, args, { stdio: 'inherit', env });
// Uses the runtime version pinned in go.mod, keeping generator and runtime aligned.
run('go', [
  'build',
  '-o',
  `${directory}/protoc-gen-go`,
  'google.golang.org/protobuf/cmd/protoc-gen-go',
]);
run('node_modules/.bin/buf', ['generate', 'protocol', '--template', 'protocol/buf.gen.yaml'], {
  ...process.env,
  XDG_CACHE_HOME: resolve('output/tools/cache'),
});
