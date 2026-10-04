import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

void test('portal directory rules compile without DOM, storage or a framework', () => {
  const files = compiledSources('scripts/checks/typescript/tsconfig.portal.json');
  assert.ok(files.includes('frontend/src/apps/play/catalog.ts'));
  for (const file of files) {
    assert.ok(
      file === 'frontend/src/apps/play/catalog.ts' ||
        file === 'frontend/src/navigation/room-reference.ts' ||
        file === 'frontend/src/contracts/mode.ts' ||
        file === 'frontend/src/contracts/server.ts' ||
        /^node_modules\/(?:typescript|@typescript\/typescript-[^/]+)\/lib\/lib\.[^/]+\.d\.ts$/.test(
          file,
        ),
      `Portal directory dependency escapes the boundary: ${file}`,
    );
  }
});

void test('all portal scripts compile with browser module semantics', () => {
  const files = compiledSources('scripts/checks/typescript/tsconfig.portal-browser.json');
  for (const file of readdirSync(resolve(root, 'frontend/src/apps/portal'))) {
    if (file.endsWith('.js')) {
      assert.ok(
        files.includes(`frontend/src/apps/portal/${file}`),
        `Unchecked portal script: ${file}`,
      );
    }
  }
});

void test('map editing and local trial depend inward without browser, renderer, concrete maps or practice', () => {
  checkClientBoundary(
    'scripts/checks/typescript/tsconfig.editor.json',
    (file) =>
      file.startsWith('frontend/src/core/') ||
      file === 'frontend/src/gameconfig/tuning.ts' ||
      [
        'frontend/src/maps/types.ts',
        'frontend/src/maps/validation.ts',
        'frontend/src/maps/decals.ts',
        'frontend/src/apps/editor/model.ts',
        'frontend/src/apps/editor/decals.ts',
        'frontend/src/apps/editor/application.ts',
        'frontend/src/content/types.ts',
        'frontend/src/apps/editor/play-world.ts',
      ].includes(file),
  );
});
function compiledSources(config: string): string[] {
  // Use the compiler's resolved graph, including transitive and type-only imports.
  // Compilation also rejects browser globals in the ES-only core configuration.
  const compiler = resolve(root, 'node_modules/typescript/bin/tsc');
  const output = execFileSync(process.execPath, [compiler, '-p', config, '--listFiles'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  // The compiler reports real paths; keep packages repository-relative when
  // node_modules is linked, as in the pre-commit snapshot.
  const modules = realpathSync(resolve(root, 'node_modules'));
  return output
    .trim()
    .split(/\r?\n/)
    .map((path) => {
      const dependency = relative(modules, path);
      const file =
        dependency.startsWith('..') || isAbsolute(dependency)
          ? relative(root, path)
          : join('node_modules', dependency);
      return file.split(sep).join('/');
    });
}

void test('core compiles without browser types and depends only on itself and standard libraries', () => {
  const files = compiledSources('scripts/checks/typescript/tsconfig.core.json');
  assert.ok(files.includes('frontend/src/core/simulation.ts'));
  for (const file of files) {
    const standardLibrary =
      /^node_modules\/(?:typescript|@typescript\/typescript-[^/]+)\/lib\/lib\.[^/]+\.d\.ts$/.test(
        file,
      );
    assert.ok(
      file.startsWith('frontend/src/core/') ||
        file === 'frontend/src/gameconfig/tuning.ts' ||
        standardLibrary,
      `Core dependency escapes the boundary: ${file}`,
    );
  }
});

void test('presentation does not depend on practice, concrete maps or simulation lifecycle', () => {
  const files = compiledSources('scripts/checks/typescript/tsconfig.presentation.json');
  assert.ok(files.includes('frontend/src/presentation/scene/renderer.ts'));
  const allowed = new Set([
    'frontend/src/core/geometry.ts',
    'frontend/src/gameconfig/tuning.ts',
    'frontend/src/maps/types.ts',
    'frontend/src/maps/validation.ts',
    'frontend/src/maps/decals.ts',
    'frontend/src/player/appearance.ts',
    'frontend/src/player/nickname.ts',
  ]);
  for (const file of files.filter((file) => file.startsWith('frontend/'))) {
    assert.ok(
      file.startsWith('frontend/src/presentation/') ||
        file.startsWith('frontend/src/content/') ||
        allowed.has(file),
      `Presentation dependency escapes the boundary: ${file}`,
    );
  }
});

void test('minimap draws visual data without Babylon or online session dependencies', () => {
  const allowed = new Set([
    'frontend/src/presentation/ui/minimap.ts',
    'frontend/src/presentation/view.ts',
    'frontend/src/presentation/camera.ts',
    'frontend/src/core/geometry.ts',
    'frontend/src/gameconfig/tuning.ts',
    'frontend/src/maps/types.ts',
    'frontend/src/player/appearance.ts',
  ]);
  for (const file of compiledSources('scripts/checks/typescript/tsconfig.minimap.json')) {
    assert.ok(
      allowed.has(file) ||
        /^node_modules\/(?:typescript|@typescript\/typescript-[^/]+)\/lib\/lib\.[^/]+\.d\.ts$/.test(
          file,
        ),
      `Minimap dependency escapes the boundary: ${file}`,
    );
  }
});

void test('Go mechanics have no world, transport or rendering dependency', () => {
  const result = JSON.parse(
    execFileSync('go', ['list', '-json', './backend/core'], { cwd: root, encoding: 'utf8' }),
  ) as { Imports: string[] };
  assert.deepEqual(result.Imports, ['baboreborn/backend/gameconfig', 'math']);
});

void test('online prediction compiles without DOM or browser adapters', () => {
  const files = compiledSources('scripts/checks/typescript/tsconfig.online.json');
  for (const file of files.filter((file) => file.startsWith('frontend/'))) {
    assert.ok(
      file.startsWith('frontend/src/core/') ||
        file === 'frontend/src/gameconfig/tuning.ts' ||
        file === 'frontend/src/prediction/model.ts' ||
        file === 'frontend/src/prediction/diagnostics.ts' ||
        file === 'frontend/src/contracts/session.ts' ||
        file === 'frontend/src/contracts/mode.ts' ||
        file === 'frontend/src/contracts/activity.ts' ||
        file === 'frontend/src/player/appearance.ts' ||
        file === 'frontend/src/maps/types.ts',
      `Online model boundary escaped: ${file}`,
    );
  }
});

const sharedData = new Set([
  'frontend/src/contracts/snapshot.ts',
  'frontend/src/gameconfig/tuning.ts',
  'frontend/src/contracts/session.ts',
  'frontend/src/contracts/activity.ts',
  'frontend/src/contracts/server.ts',
  'frontend/src/contracts/mode.ts',
  'frontend/src/player/appearance.ts',
  'frontend/src/player/nickname.ts',
  'frontend/src/maps/types.ts',
  'frontend/src/maps/validation.ts',
  'frontend/src/maps/decals.ts',
]);
function checkClientBoundary(config: string, allowed: (file: string) => boolean): void {
  for (const file of compiledSources(config).filter((file) => file.startsWith('frontend/')))
    assert.ok(allowed(file), `${config} dependency escapes the boundary: ${file}`);
}
void test('session contracts and wire decoder do not depend on prediction or browser adapters', () => {
  checkClientBoundary(
    'scripts/checks/typescript/tsconfig.contracts.json',
    (file) => sharedData.has(file) || file.startsWith('frontend/src/core/'),
  );
  checkClientBoundary(
    'scripts/checks/typescript/tsconfig.network.json',
    (file) =>
      sharedData.has(file) ||
      file.startsWith('frontend/src/core/') ||
      [
        'frontend/src/network/protocol.ts',
        'frontend/src/network/protobuf.ts',
        'frontend/src/network/precision.ts',
        'frontend/src/network/generated/snapshot_pb.ts',
        'frontend/src/network/payload.ts',
      ].includes(file),
  );
});
void test('online session, lifecycle and feedback run without DOM, sockets, renderer or practice', () => {
  checkClientBoundary(
    'scripts/checks/typescript/tsconfig.session.json',
    (file) =>
      sharedData.has(file) ||
      file.startsWith('frontend/src/core/') ||
      [
        'frontend/src/prediction/model.ts',
        'frontend/src/prediction/diagnostics.ts',
        'frontend/src/apps/match/correction-history.ts',
        'frontend/src/apps/match/session.ts',
        'frontend/src/apps/match/lifecycle.ts',
        'frontend/src/apps/match/diagnostic-history.ts',
        'frontend/src/apps/match/combat-feedback.ts',
        'frontend/src/presentation/effects/damage-feedback.ts',
        'frontend/src/apps/match/activity-feed.ts',
        'frontend/src/apps/match/kill-notice.ts',
        'frontend/src/apps/match/minimap-reveals.ts',
        'frontend/src/apps/match/view.ts',
        'frontend/src/apps/match/menu-state.ts',
        'frontend/src/apps/match/screen.ts',
        'frontend/src/player/player-preferences.ts',
        'frontend/src/player/game-options.ts',
        'frontend/src/presentation/view.ts',
        'frontend/src/presentation/camera.ts',
        'frontend/src/presentation/actors/knife-state.ts',
        'frontend/src/presentation/actors/team-style.ts',
      ].includes(file),
  );
});
void test('online application cannot consume practice or concrete map content', () => {
  checkClientBoundary(
    'scripts/checks/typescript/tsconfig.online-app.json',
    (file) =>
      !file.startsWith('frontend/src/apps/practice/') &&
      (!file.startsWith('frontend/src/maps/') ||
        [
          'frontend/src/maps/types.ts',
          'frontend/src/maps/validation.ts',
          'frontend/src/maps/decals.ts',
        ].includes(file)),
  );
});
void test('match dependency graph excludes transports, external packages and concrete maps', () => {
  const dependencies = execFileSync(
    'go',
    ['list', '-deps', '-f', '{{if not .Standard}}{{.ImportPath}}{{end}}', './backend/server/match'],
    { cwd: root, encoding: 'utf8' },
  )
    .trim()
    .split(/\s+/);
  assert.deepEqual(
    dependencies.filter((name) => !name.startsWith('google.golang.org/protobuf/')).sort(),
    [
      'baboreborn/backend/server/bots',
      'baboreborn/backend/core',
      'baboreborn/backend/maps',
      'baboreborn/backend/server/match',
      'baboreborn/backend/gameconfig',
    ].sort(),
  );
  const imports = JSON.parse(
    execFileSync('go', ['list', '-json', './backend/server/match'], {
      cwd: root,
      encoding: 'utf8',
    }),
  ) as { Deps: string[] };
  assert.ok(
    !imports.Deps.some(
      (name) => name === 'net' || name.startsWith('net/') || name === 'database/sql',
    ),
  );
});

void test('bot decisions and navigation cannot import match state, transport or concrete maps', () => {
  for (const name of ['bots', 'navigation']) {
    const dependencies = execFileSync(
      'go',
      [
        'list',
        '-deps',
        '-f',
        '{{if not .Standard}}{{.ImportPath}}{{end}}',
        `./backend/server/${name}`,
      ],
      { cwd: root, encoding: 'utf8' },
    )
      .trim()
      .split(/\s+/);
    assert.deepEqual(
      dependencies.filter((name) => !name.startsWith('google.golang.org/protobuf/')).sort(),
      [
        `baboreborn/backend/server/${name}`,
        'baboreborn/backend/core',
        'baboreborn/backend/gameconfig',
      ].sort(),
    );
    const result = JSON.parse(
      execFileSync('go', ['list', '-json', `./backend/server/${name}`], {
        cwd: root,
        encoding: 'utf8',
      }),
    ) as { Deps: string[] };
    assert.ok(
      !result.Deps.some((dependency) => dependency === 'net' || dependency.startsWith('net/')),
    );
  }
});

void test('tuning modules contain configuration without runtime dependencies', () => {
  const files = compiledSources('scripts/checks/typescript/tsconfig.tuning.json');
  assert.deepEqual(
    files.filter((file) => !file.startsWith('node_modules/')),
    ['frontend/src/gameconfig/tuning.ts'],
  );
  const result = JSON.parse(
    execFileSync('go', ['list', '-json', './backend/gameconfig'], {
      cwd: root,
      encoding: 'utf8',
    }),
  ) as { Imports?: string[] };
  assert.deepEqual(result.Imports ?? [], []);
});

void test('outgoing Go wire adapter depends inward on authority, with no transport dependency', () => {
  const dependencies = execFileSync(
    'go',
    ['list', '-deps', '-f', '{{if not .Standard}}{{.ImportPath}}{{end}}', './backend/server/wire'],
    { cwd: root, encoding: 'utf8' },
  )
    .trim()
    .split(/\s+/);
  assert.deepEqual(
    dependencies.filter((name) => !name.startsWith('google.golang.org/protobuf/')).sort(),
    [
      'baboreborn/backend/server/bots',
      'baboreborn/backend/core',
      'baboreborn/backend/maps',
      'baboreborn/backend/server/match',
      'baboreborn/backend/gameconfig',
      'baboreborn/backend/server/wire',
      'baboreborn/backend/server/wire/pb',
    ].sort(),
  );
});

void test('replication delegates Protobuf framing to the wire codec', () => {
  const result = JSON.parse(
    execFileSync('go', ['list', '-json', './backend/server/replication'], {
      cwd: root,
      encoding: 'utf8',
    }),
  ) as { Imports: string[] };
  assert.deepEqual(
    result.Imports.filter(
      (name) =>
        name.startsWith('google.golang.org/protobuf/') ||
        name === 'baboreborn/backend/server/wire/pb',
    ),
    [],
  );
});

void test('match admission depends on route and data contracts without DOM, sockets or rendering', () => {
  checkClientBoundary(
    'scripts/checks/typescript/tsconfig.access.json',
    (file) =>
      sharedData.has(file) ||
      file.startsWith('frontend/src/core/') ||
      [
        'frontend/src/apps/match/access.ts',
        'frontend/src/navigation/routes.ts',
        'frontend/src/navigation/room-reference.ts',
      ].includes(file),
  );
});

void test('application state uses Solid and Query without network adapters or renderer dependencies', () => {
  const files = compiledSources('scripts/checks/typescript/tsconfig.rooms.json');
  for (const file of files) {
    assert.ok(
      file.startsWith('node_modules/solid-js/') ||
        file.startsWith('node_modules/@tanstack/') ||
        file.startsWith('node_modules/csstype/') ||
        file.startsWith('node_modules/@types/node/') ||
        file.startsWith('node_modules/undici-types/') ||
        file.startsWith('node_modules/typescript/') ||
        /^node_modules\/@typescript\/typescript-[^/]+\/lib\/lib\.[^/]+\.d\.ts$/.test(file) ||
        sharedData.has(file) ||
        file.startsWith('frontend/src/core/') ||
        [
          'frontend/src/contracts/server.ts',
          'frontend/src/apps/management/application.ts',
          'frontend/src/apps/management/rules.ts',
          'frontend/src/player/preferences.ts',
          'frontend/src/apps/management/staff-application.ts',
          'frontend/src/player/player-preferences.ts',
          'frontend/src/player/game-options.ts',
          'frontend/src/content/types.ts',
          'frontend/src/navigation/routes.ts',
          'frontend/src/navigation/room-reference.ts',
        ].includes(file),
      `Rooms application dependency escapes the boundary: ${file}`,
    );
  }
});

void test('central executables do not include community-server runtime dependencies', () => {
  for (const entry of ['central', 'devcentral']) {
    const dependencies = execFileSync('go', ['list', '-deps', `./backend/cmd/${entry}`], {
      cwd: root,
      encoding: 'utf8',
    })
      .trim()
      .split(/\s+/);
    assert.ok(
      !dependencies.some((name) => /^baboreborn\/backend\/server(?:\/|$)/.test(name)),
      `${entry} must use shared content and compatibility rather than server runtime packages`,
    );
  }
});

void test('shared content and compatibility do not depend on either service', () => {
  for (const entry of ['content', 'compatibility']) {
    const dependencies = execFileSync('go', ['list', '-deps', `./backend/${entry}`], {
      cwd: root,
      encoding: 'utf8',
    })
      .trim()
      .split(/\s+/);
    assert.ok(
      !dependencies.some((name) => /^baboreborn\/backend\/(server|central|web)(?:\/|$)/.test(name)),
      `${entry} must remain independent of service implementation and frontend embedding`,
    );
  }
});

void test('community server executable does not embed content, the portal or central service', () => {
  const dependencies = execFileSync('go', ['list', '-deps', './backend/cmd/server'], {
    cwd: root,
    encoding: 'utf8',
  })
    .trim()
    .split(/\s+/);
  assert.ok(!dependencies.some((name) => /^baboreborn\/backend\/(central|web)(?:\/|$)/.test(name)));
  assert.ok(!dependencies.includes('baboreborn/content'));
});
