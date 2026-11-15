import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../deploy/docker/deploy.sh', import.meta.url));
const tag = 'v1.2.3';
const sourceCommit = '0123456789abcdef'.padEnd(40, '0');
const digest = (char) => `sha256:${char.repeat(64)}`;
const OLD = {
  central: `old/baboreborn-central@${digest('a')}`,
  server: `old/baboreborn-server@${digest('b')}`,
};
const NEW = {
  central: `new/baboreborn-central@${digest('c')}`,
  server: `new/baboreborn-server@${digest('d')}`,
};
const COMPOSE_FILES = ['compose.yaml', 'compose.server.yaml', 'compose.postgres.yaml'];

// Stand-ins log every call; behavior is driven by FAKE_* variables.
const fakeDocker = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOG"
[ "$1" = pull ] && exit 0
shift
candidate=0
[ "$1" = --project-directory ] && candidate=1
# Candidate validation supplies global Compose flags before the subcommand.
while [ "$1" != config ] && [ "$1" != ps ] && [ "$1" != cp ] && [ "$1" != up ] && [ "$1" != run ] && [ "$1" != stop ]; do shift; done
for last; do :; done
case "$1" in
  config) [ "$FAKE_INVALID_CONFIG" = 1 ] && [ "$candidate" = 1 ] && exit 1; printf '%s\\n' $FAKE_SERVICES ;;
  ps) selected=$FAKE_RUNNING
    case " $* " in *" --all "*) selected=$FAKE_EXISTING ;; esac
    case " $selected " in *" $last "*) echo "id-$last" ;; esac ;;
  cp) echo "copy of $2" > "$3" ;;
  run) [ "$FAKE_BACKUP_FAILURE" = 1 ] && exit 1 ;;
  up) [ "$(sed -n 's/^CENTRAL_IMAGE=//p' .env)" = "$FAKE_BROKEN_IMAGE" ] && exit 1 ;;
esac
exit 0
`;
const fakeCurl = `#!/bin/sh
out=
for arg; do
  case "$prev" in -o) out=$arg ;; esac
  prev=$arg url=$arg
done
file="$FAKE_HTTP_ROOT/\${url#https://}"
[ -f "$file" ] || exit 22
cp "$file" "$out"
`;

function fixture(
  t,
  {
    env = {},
    services = 'central postgres server',
    running = 'central server',
    existing = running,
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'baboreborn-deploy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const install = join(root, 'install');
  const bin = join(root, 'bin');
  const http = join(root, 'http');
  const write = (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  write(join(bin, 'docker'), fakeDocker);
  write(join(bin, 'curl'), fakeCurl);
  write(join(bin, 'sleep'), '#!/bin/sh\n');
  for (const name of ['docker', 'curl', 'sleep']) chmodSync(join(bin, name), 0o755);
  mkdirSync(install);
  copyFileSync(script, join(install, 'deploy.sh'));
  chmodSync(join(install, 'deploy.sh'), 0o755);
  write(
    join(install, '.env'),
    Object.entries({
      COMPOSE_FILE: 'compose.yaml:compose.postgres.yaml',
      CENTRAL_ORIGIN: 'https://portal.example.org',
      CENTRAL_IMAGE: OLD.central,
      SERVER_IMAGE: OLD.server,
      ...env,
    })
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );
  for (const file of COMPOSE_FILES) {
    write(join(install, file), 'old\n');
    write(
      join(
        http,
        `raw.githubusercontent.com/pacoricci/BaboReborn/${sourceCommit}/deploy/docker/${file}`,
      ),
      'new\n',
    );
  }
  write(
    join(http, `github.com/pacoricci/BaboReborn/releases/download/${tag}/images.txt`),
    `Source: ${sourceCommit}\n${NEW.central}\n${NEW.server}\n`,
  );
  write(join(http, 'portal.example.org/healthz'), 'ok\n');
  const log = join(root, 'calls.log');
  writeFileSync(log, '');
  const vars = {
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_LOG: log,
    FAKE_HTTP_ROOT: http,
    FAKE_SERVICES: services,
    FAKE_RUNNING: running,
    FAKE_EXISTING: existing,
    FAKE_BROKEN_IMAGE: '',
    FAKE_INVALID_CONFIG: '',
    FAKE_BACKUP_FAILURE: '',
  };
  return {
    install,
    http,
    read: (file) => readFileSync(join(install, file), 'utf8'),
    calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean),
    run: (extra = {}, name = tag) =>
      spawnSync(join(install, 'deploy.sh'), [name], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ...vars, ...extra },
      }),
  };
}

const imageLines = (env) => env.split('\n').filter((line) => /^(CENTRAL|SERVER)_IMAGE=/.test(line));

test('backs up the running release, then switches images and Compose files', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(imageLines(f.read('.env')), [
    `CENTRAL_IMAGE=${NEW.central}`,
    `SERVER_IMAGE=${NEW.server}`,
  ]);
  for (const file of COMPOSE_FILES) assert.equal(f.read(file), 'new\n');

  const [backup] = readdirSync(join(f.install, 'backups'));
  assert.match(backup, new RegExp(`^\\d{8}T\\d{6}Z-before-${tag}$`));
  assert.deepEqual(readdirSync(join(f.install, 'backups', backup)).sort(), [
    '.env',
    'central.dump',
    ...COMPOSE_FILES.toSorted(),
    'keys.json',
    'server.sqlite',
    'signing.pem',
  ]);

  const calls = f.calls();
  const at = (pattern) => calls.findIndex((call) => pattern.test(call));
  assert.ok(at(/^pull new\/baboreborn-central/) < at(/^compose stop central server$/));
  assert.ok(at(/^compose stop/) < at(/-storage backup/));
  assert.ok(at(/--entrypoint rm central/) < at(/^compose up -d --no-build/));
  assert.match(f.read('.deploy/history'), new RegExp(` ${tag} deployed\\n$`));
  assert.equal(existsSync(join(f.install, '.deploy/lock')), false);
});

test('restores the previous release when the new one fails to start', (t) => {
  const f = fixture(t);
  const result = f.run({ FAKE_BROKEN_IMAGE: NEW.central });
  assert.notEqual(result.status, 0);
  assert.deepEqual(imageLines(f.read('.env')), [
    `CENTRAL_IMAGE=${OLD.central}`,
    `SERVER_IMAGE=${OLD.server}`,
  ]);
  for (const file of COMPOSE_FILES) assert.equal(f.read(file), 'old\n');
  assert.equal(f.calls().filter((call) => call.startsWith('compose up')).length, 2);
  assert.match(f.read('.deploy/history'), / rolled-back\n$/);
});

test('restores the previous release when the public health check fails', (t) => {
  const f = fixture(t);
  rmSync(join(f.http, 'portal.example.org/healthz'));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /healthz did not become healthy/);
  assert.deepEqual(imageLines(f.read('.env')), [
    `CENTRAL_IMAGE=${OLD.central}`,
    `SERVER_IMAGE=${OLD.server}`,
  ]);
  assert.match(f.read('.deploy/history'), / rolled-back\n$/);
});

test('verifies an unchanged release without taking another backup', (t) => {
  const f = fixture(t, { env: { CENTRAL_IMAGE: NEW.central, SERVER_IMAGE: NEW.server } });
  for (const file of COMPOSE_FILES) writeFileSync(join(f.install, file), 'new\n');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /already deployed/);
  assert.ok(f.calls().some((call) => call.startsWith('compose up')));
  assert.ok(!f.calls().some((call) => call.startsWith('compose stop')));
  assert.equal(existsSync(join(f.install, 'backups')), false);
  assert.match(f.read('.deploy/history'), / verified\n$/);
  assert.equal(f.read('compose.yaml'), 'new\n');
});

test('a standalone community host neither pulls nor backs up central', (t) => {
  const f = fixture(t, {
    env: { COMPOSE_FILE: 'compose.server.yaml', CENTRAL_ORIGIN: 'https://portal.example.org' },
    services: 'server',
    running: 'server',
  });
  rmSync(join(f.http, 'portal.example.org/healthz'));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  assert.ok(!calls.some((call) => call.includes('central')), calls.join('\n'));
  assert.ok(calls.includes('compose stop server'));
});

test('a first deployment starts without a backup', (t) => {
  const f = fixture(t, { running: '' });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(f.install, 'backups')), false);
  assert.ok(!f.calls().some((call) => call.startsWith('compose stop')));
});

test('refuses to change anything without an explicit COMPOSE_FILE', (t) => {
  const f = fixture(t, { env: { COMPOSE_FILE: '' } });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Set COMPOSE_FILE/);
  assert.deepEqual(f.calls(), []);
});

test('rejects malformed tags and unpublished releases before any change', (t) => {
  const f = fixture(t);
  assert.match(f.run({}, 'v1.2').stderr, /Usage/);
  const missing = f.run({}, 'v9.9.9');
  assert.notEqual(missing.status, 0);
  assert.deepEqual(f.calls(), []);
  assert.equal(f.read('compose.yaml'), 'old\n');
  assert.match(f.read('.deploy/history'), / v9\.9\.9 aborted\n$/);
});

test('validates candidate configuration before pulling or stopping services', (t) => {
  const f = fixture(t);
  const result = f.run({ FAKE_INVALID_CONFIG: '1' });
  assert.notEqual(result.status, 0);
  assert.ok(!f.calls().some((call) => /^(pull|compose stop)/.test(call)));
  assert.equal(f.read('compose.yaml'), 'old\n');
  assert.match(f.read('.deploy/history'), / aborted\n$/);
});

test('a failed backup restarts the old release without switching configuration', (t) => {
  const f = fixture(t);
  const result = f.run({ FAKE_BACKUP_FAILURE: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(f.read('compose.yaml'), 'old\n');
  assert.match(f.read('.env'), new RegExp(OLD.central));
  assert.match(f.read('.deploy/history'), / rolled-back\n$/);
  assert.equal(existsSync(join(f.install, '.deploy/lock')), false);
});

test('updates outdated Compose files even when image digests already match', (t) => {
  const f = fixture(t, { env: { CENTRAL_IMAGE: NEW.central, SERVER_IMAGE: NEW.server } });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.read('compose.yaml'), 'new\n');
  assert.ok(f.calls().includes('compose stop central server'));
});

test('removes newly introduced Compose files when rolling back', (t) => {
  const f = fixture(t, {
    env: { COMPOSE_FILE: 'compose.server.yaml' },
    services: 'server',
    running: 'server',
  });
  rmSync(join(f.install, 'compose.postgres.yaml'));
  const result = f.run({ FAKE_BROKEN_IMAGE: NEW.central });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(f.install, 'compose.postgres.yaml')), false);
  assert.equal(f.read('compose.server.yaml'), 'old\n');
});

test('refuses overlapping deployments before fetching or touching services', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.install, '.deploy/lock'), { recursive: true });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Another deployment/);
  assert.deepEqual(f.calls(), []);
});

test('rejects release metadata without an immutable source commit', (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.http, `github.com/pacoricci/BaboReborn/releases/download/${tag}/images.txt`),
    `Source: main\n${NEW.central}\n${NEW.server}\n`,
  );
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source commit/);
  assert.deepEqual(f.calls(), []);
});

test('an unchanged release still fails when its public endpoint is unhealthy', (t) => {
  const f = fixture(t, { env: { CENTRAL_IMAGE: NEW.central, SERVER_IMAGE: NEW.server } });
  for (const file of COMPOSE_FILES) writeFileSync(join(f.install, file), 'new\n');
  rmSync(join(f.http, 'portal.example.org/healthz'));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /healthz did not become healthy/);
  assert.match(f.read('.deploy/history'), / aborted\n$/);
});

test('a failed first deployment restores configuration and leaves services stopped', (t) => {
  const f = fixture(t, { running: '' });
  const result = f.run({ FAKE_BROKEN_IMAGE: NEW.central });
  assert.notEqual(result.status, 0);
  assert.equal(f.read('compose.yaml'), 'old\n');
  assert.match(f.read('.env'), new RegExp(OLD.central));
  assert.equal(f.calls().filter((call) => call.startsWith('compose up')).length, 1);
  assert.ok(f.calls().includes('compose stop'));
  assert.match(f.read('.deploy/history'), / failed\n$/);
});

test('backs up an existing stopped service before starting the new release', (t) => {
  const f = fixture(t, { running: '', existing: 'central server' });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const [backup] = readdirSync(join(f.install, 'backups'));
  assert.ok(existsSync(join(f.install, 'backups', backup, 'central.dump')));
  assert.ok(existsSync(join(f.install, 'backups', backup, 'server.sqlite')));
  assert.ok(!f.calls().some((call) => call.startsWith('compose stop')));
});

test('a failed deployment leaves previously stopped services stopped', (t) => {
  const f = fixture(t, { running: '', existing: 'central server' });
  const result = f.run({ FAKE_BROKEN_IMAGE: NEW.central });
  assert.notEqual(result.status, 0);
  assert.equal(f.calls().filter((call) => call.startsWith('compose up')).length, 1);
  assert.ok(f.calls().includes('compose stop'));
  assert.match(f.read('.deploy/history'), / failed\n$/);
});
