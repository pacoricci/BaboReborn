import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

// Exercise Compose's real merge/interpolation rules without a daemon or real secrets.
function config(t, files, community = false) {
  const directory = mkdtempSync(join(tmpdir(), 'baboreborn-compose-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const envFile = join(directory, '.env');
  writeFileSync(envFile, '');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('COMPOSE_')),
  );
  Object.assign(env, {
    CENTRAL_ORIGIN: 'https://portal.example.org',
    CENTRAL_IMAGE: 'example/central:fixture',
    SERVER_IMAGE: 'example/server:fixture',
    CENTRAL_CONFIG_DIR: join(directory, 'central'),
    SERVER_CONFIG_DIR: join(directory, 'server'),
    POSTGRES_PASSWORD_FILE: join(directory, 'local-password'),
    CENTRAL_BIND: '127.0.0.1',
    CENTRAL_PORT: '9443',
    SERVER_BIND: '127.0.0.1',
    SERVER_PORT: '9444',
    PAIRING_CODE_FILE: '',
    SMOKE_CENTRAL_PORT: '38090',
    SMOKE_SERVER_PORT: '38080',
    SMOKE_DATABASE_NETWORK: 'independent-database_default',
  });
  const result = execFileSync(
    process.env.DOCKER ?? 'docker',
    [
      'compose',
      '--env-file',
      envFile,
      '-p',
      'baboreborn-config-test',
      ...files.flatMap((file) => ['-f', join(root, 'deploy/docker', file)]),
      ...(community ? ['--profile', 'community'] : []),
      'config',
      '--format',
      'json',
    ],
    { env, encoding: 'utf8', timeout: 30000 },
  );
  return { model: JSON.parse(result), directory };
}

for (const local of [false, true]) {
  for (const community of [false, true]) {
    test(`${local ? 'local' : 'external'} database${community ? ' with community server' : ''}`, (t) => {
      const files = ['compose.yaml', ...(local ? ['compose.postgres.yaml'] : [])];
      const { model, directory } = config(t, files, community);
      assert.deepEqual(
        Object.keys(model.services).sort(),
        ['central', ...(local ? ['postgres'] : []), ...(community ? ['server'] : [])].sort(),
      );
      const central = model.services.central;
      assert.equal(central.image, 'example/central:fixture');
      assert.equal(central.environment.CENTRAL_DATABASE_URL_FILE, '/run/config/database-url');
      assert.equal(central.environment.CENTRAL_DATABASE_URL, undefined);
      assert.equal(central.ports[0].host_ip, '127.0.0.1');
      assert.equal(central.ports[0].published, '9443');
      assert.equal(central.ports[0].target, 8443);
      const mount = central.volumes.find(({ target }) => target === '/run/config');
      assert.equal(mount.source, join(directory, 'central'));
      assert.equal(mount.read_only, true);
      assert.equal(mount.bind.create_host_path, false);
      // Existing installations must retain their application and database volume identities.
      assert.equal(model.volumes['central-data'].name, 'baboreborn-config-test_central-data');
      if (local) {
        assert.equal(central.depends_on.postgres.condition, 'service_healthy');
        assert.equal(model.services.postgres.image, 'postgres:17-trixie');
        assert.equal(model.services.postgres.ports, undefined);
        assert.equal(model.secrets['postgres-password'].file, join(directory, 'local-password'));
        assert.equal(model.volumes['postgres-data'].name, 'baboreborn-config-test_postgres-data');
      } else {
        assert.deepEqual(central.depends_on ?? {}, {});
        assert.deepEqual(model.secrets ?? {}, {});
        assert.equal(model.volumes['postgres-data'], undefined);
      }
      if (community) assert.equal(model.services.server.image, 'example/server:fixture');
    });
  }
}

test('standalone community deployment needs no database resources', (t) => {
  const { model } = config(t, ['compose.server.yaml']);
  assert.deepEqual(Object.keys(model.services), ['server']);
  assert.deepEqual(model.secrets ?? {}, {});
  assert.deepEqual(Object.keys(model.volumes), ['server-data']);
});

for (const local of [false, true]) {
  test(`smoke fixture uses ${local ? 'local' : 'independently managed'} PostgreSQL`, (t) => {
    const { model } = config(
      t,
      [
        'compose.yaml',
        ...(local ? ['compose.postgres.yaml'] : []),
        'compose.smoke.yaml',
        ...(local ? [] : ['compose.external-smoke.yaml']),
      ],
      true,
    );
    assert.equal(model.services.server.network_mode, 'service:central');
    assert.deepEqual(model.services.central.ports.map(({ published }) => published).sort(), [
      '38080',
      '38090',
    ]);
    if (local) {
      assert.equal(model.services.central.depends_on.postgres.condition, 'service_healthy');
    } else {
      assert.equal(model.services.postgres, undefined);
      assert.equal(model.networks.default.external, true);
      assert.equal(model.networks.default.name, 'independent-database_default');
    }
  });
}
