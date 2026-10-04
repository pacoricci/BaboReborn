import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as tuning from '../../src/gameconfig/tuning';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const title = (name: string) => name[0]!.toUpperCase() + name.slice(1);
const goGroup = (name: string) =>
  name
    .split('_')
    .map((part) => title(part.toLowerCase()))
    .join('');
function tsValues(): Record<string, number | boolean> {
  return Object.fromEntries(
    Object.entries(tuning).flatMap(([group, fields]) =>
      Object.entries(fields).map(([key, value]) => [goGroup(group) + title(key), value]),
    ),
  );
}
function goValues(): Record<string, number | boolean> {
  return JSON.parse(
    execFileSync('go', ['run', './backend/cmd/tuning-values', 'backend/gameconfig/rules.go'], {
      cwd: root,
      encoding: 'utf8',
    }),
  ) as Record<string, number | boolean>;
}
function assertAligned(go: Record<string, number | boolean>): void {
  const ts = tsValues();
  assert.deepEqual(
    Object.keys(go).sort(),
    Object.keys(ts).sort(),
    'Parameter names differ between frontend/src/gameconfig/tuning.ts and backend/gameconfig/rules.go',
  );
  for (const [name, expected] of Object.entries(ts))
    assert.equal(
      go[name],
      expected,
      `${name}: align frontend/src/gameconfig/tuning.ts and backend/gameconfig/rules.go`,
    );
}
void test('all directly edited TypeScript and Go parameters are aligned', () => {
  const go = goValues();
  assertAligned(go);
  assert.deepEqual(
    JSON.parse(
      execFileSync('go', ['run', './backend/cmd/tuning-values', '--runtime'], {
        cwd: root,
        encoding: 'utf8',
      }),
    ),
    go,
    'Discovery must include every compiled tuning value',
  );
  assert.throws(
    () => assertAligned({ ...go, ShieldCooldownSeconds: Number(go.ShieldCooldownSeconds) + 1 }),
    /ShieldCooldownSeconds/,
  );
});
void test('tuning values satisfy gameplay and geometry constraints', () => {
  for (const [name, value] of Object.entries(tsValues())) {
    if (typeof value === 'boolean') continue;
    assert.ok(Number.isFinite(value), `${name} must be finite`);
    if (name !== 'CameraMinZoom' && !name.includes('MuzzleRight'))
      assert.ok(value >= 0, `${name} must be nonnegative`);
  }
  const { MOVEMENT, SMG, SHOTGUN, SHIELD, KNIVES, GRENADE, MOLOTOV, DEATHMATCH, CAMERA } = tuning;
  for (const count of [
    SHOTGUN.pellets,
    SHOTGUN.shells,
    GRENADE.spawnCount,
    GRENADE.maxCarry,
    MOLOTOV.spawnCount,
    DEATHMATCH.scoreLimit,
    tuning.PICKUPS.guaranteedDropItems,
    tuning.PICKUPS.maxItems,
  ])
    assert.ok(Number.isSafeInteger(count));
  assert.ok(SHOTGUN.pellets >= 1 && SHOTGUN.pellets <= 64);
  assert.ok(SHOTGUN.shells >= 1 && SHOTGUN.shells <= 1000);
  assert.ok(GRENADE.spawnCount <= GRENADE.maxCarry && GRENADE.maxCarry <= 100);
  assert.ok(MOLOTOV.spawnCount <= 100);
  assert.ok(tuning.PICKUPS.guaranteedDropItems < tuning.PICKUPS.maxItems);
  assert.ok(MOVEMENT.radius > 0 && MOVEMENT.radius + MOVEMENT.clearance < 0.5);
  assert.ok(SMG.minSpreadDegrees <= SMG.maxSpreadDegrees && SMG.maxSpreadDegrees < 90);
  assert.ok(SHIELD.inactiveTailSeconds < SHIELD.protectionSeconds);
  assert.ok(
    SHIELD.damageMultiplier <= 1 &&
      MOVEMENT.bounce <= 1 &&
      tuning.FLIGHT.bounceRetention <= 1 &&
      MOLOTOV.reflectionScale <= 1,
  );
  assert.ok(DEATHMATCH.spawnInactiveTailSeconds <= DEATHMATCH.spawnProtectionSeconds);
  assert.ok(KNIVES.visualSeconds > 0 && KNIVES.visualSeconds <= KNIVES.cooldownSeconds);
  assert.ok(CAMERA.near > 0 && CAMERA.near < CAMERA.far);
  assert.ok(CAMERA.playerWeight + CAMERA.aimWeight > 0);
  assert.ok(CAMERA.spectatorHeight + CAMERA.minZoom > 0);
  for (const value of [
    SMG.fireIntervalSeconds,
    SHOTGUN.fireIntervalSeconds,
    SHOTGUN.reloadSeconds,
    GRENADE.fuseSeconds,
    GRENADE.radius,
    MOLOTOV.flightSeconds,
    MOLOTOV.flameSeconds,
    MOLOTOV.damageIntervalSeconds,
    MOLOTOV.damageRadius,
    MOLOTOV.attachSeconds,
    tuning.PLAYER.maxHealth,
    DEATHMATCH.endSeconds,
  ])
    assert.ok(value > 0);
});

void test('direct edits change real TS and Go mechanics and authoritative entities', async () => {
  const changes = {
    shield: {
      cooldownSeconds: 5,
      protectionSeconds: 4,
      inactiveTailSeconds: 1,
      damageMultiplier: 0.25,
    },
    grenade: {
      spawnCount: 4,
      maxCarry: 5,
      fuseSeconds: 1.25,
      horizontalSpeed: 7,
      radius: 2,
      damage: 90,
    },
    molotov: { spawnCount: 2, flameSeconds: 4, damageIntervalSeconds: 0.25, damage: 24 },
    shotgun: { pellets: 7, shells: 3, recoil: 2, fireIntervalSeconds: 0.5, reloadSeconds: 2 },
    player: { maxHealth: 160 },
    deathmatch: { respawnSeconds: 0.5, scoreLimit: 12 },
  };
  // Mutate only temporary copies of the two hand-maintained files.
  let tsSource = await readFile(join(root, 'frontend/src/gameconfig/tuning.ts'), 'utf8');
  let goSource = await readFile(join(root, 'backend/gameconfig/rules.go'), 'utf8');
  for (const [group, fields] of Object.entries(changes)) {
    const tsGroup = group.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
    for (const [key, value] of Object.entries(fields)) {
      const block = new RegExp(`(export const ${tsGroup} = \\{[\\s\\S]*?\\n\\s*${key}: )[^,]+`);
      assert.match(tsSource, block);
      tsSource = tsSource.replace(block, `$1${value}`);
      const constant = new RegExp(
        `(\\b${title(group)}${title(key)}\\s+(?:float64|int|bool)\\s*=\\s*)[^\\n]+`,
      );
      assert.match(goSource, constant);
      goSource = goSource.replace(constant, `$1${value}`);
    }
  }
  const temp = await mkdtemp(join(tmpdir(), 'baboreborn-tuning-'));
  try {
    await writeFile(join(temp, 'package.json'), '{"type":"module"}');
    await cp(join(root, 'go.mod'), join(temp, 'go.mod'));
    await cp(join(root, 'go.sum'), join(temp, 'go.sum'));
    await cp(join(root, 'content'), join(temp, 'content'), { recursive: true });
    await cp(join(root, 'backend/cmd/server'), join(temp, 'backend/cmd/server'), {
      recursive: true,
    });
    for (const scope of ['storage', 'access', 'administration', 'registration'])
      await cp(join(root, 'backend/server', scope), join(temp, 'backend/server', scope), {
        recursive: true,
      });
    await cp(join(root, 'backend/registry'), join(temp, 'backend/registry'), { recursive: true });
    await cp(join(root, 'backend/release'), join(temp, 'backend/release'), { recursive: true });
    await cp(join(root, 'backend/identity'), join(temp, 'backend/identity'), { recursive: true });
    await cp(join(root, 'backend/internal'), join(temp, 'backend/internal'), { recursive: true });
    for (const scope of ['content', 'gameconfig', 'compatibility', 'core', 'maps'])
      await cp(join(root, 'backend', scope), join(temp, 'backend', scope), { recursive: true });
    await cp(join(root, 'frontend/src/core'), join(temp, 'frontend/src/core'), { recursive: true });
    for (const scope of [
      'match',
      'bots',
      'navigation',
      'transport',
      'wire',
      'hosting',
      'replication',
    ]) {
      const dest = join(temp, 'backend/server', scope);
      await mkdir(dest, { recursive: true });
      for (const name of await readdir(join(root, 'backend/server', scope)))
        if (name.endsWith('.go') && !name.endsWith('_test.go'))
          await cp(join(root, 'backend/server', scope, name), join(dest, name));
    }
    await cp(join(root, 'backend/server/wire/pb'), join(temp, 'backend/server/wire/pb'), {
      recursive: true,
    });
    await mkdir(join(temp, 'frontend/src/gameconfig'), { recursive: true });
    await writeFile(join(temp, 'frontend/src/gameconfig/tuning.ts'), tsSource);
    await writeFile(join(temp, 'backend/gameconfig/rules.go'), goSource);
    const moduleUrl = pathToFileURL(join(temp, 'frontend/src/core/')).href;
    const result: unknown = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `
      import { createEquipment, act } from '${moduleUrl}equipment.ts';
      import { createPlayer, stepPlayer } from '${moduleUrl}simulation.ts';
      import { createCollisionGrid } from '${moduleUrl}grid.ts';
      const p = createPlayer({x: 8, y: 8}, 0);
      p.equipment = createEquipment('smg', 'shield'); p.cooldown = 0;
      act(p, {secondary: true});
      const shield = {...p.equipment};
      p.equipment = createEquipment('shotgun');
      const shot = stepPlayer(p, {x: 0, y: 0, aim: {x: 20, y: 8}, fire: true}, 1/120,
        {walls: [], grid: createCollisionGrid({x: 0,y: 0,w: 36,h: 36}, [])}, [], {seed: 1},
        {muzzleOffset: .4, muzzleSide: .16, muzzleHeight: .25, maxDistance: 128, wallHeight: .7});
      console.log(JSON.stringify({shield, pellets: shot.pellets.length, cooldown: p.cooldown, vx: p.vx}));
    `,
        ],
        { cwd: root, encoding: 'utf8' },
      ),
    );
    assert.deepEqual(result, {
      shield: {
        heat: 1,
        overheated: false,
        charge: 0,
        fireTime: 0,
        sinceShot: 1,
        scopeHeight: 7,
        rocketActive: false,
        rocketAge: 0,
        primaryAction: '',
        barrel: 0,
        primary: 'smg',
        secondary: 'shield',
        grenades: 4,
        molotovs: 2,
        shells: 0,
        meleeDelay: 5,
        throwDelay: 0,
        protection: 4,
        secondaryActivated: true,
        action: 'shield',
      },
      pellets: 7,
      cooldown: 0.5,
      vx: -2,
    });
    await writeFile(
      join(temp, 'backend/server/match/tuning_probe_test.go'),
      `package match
import ("testing"; "baboreborn/backend/core"; "baboreborn/backend/gameconfig")
func TestDirectEditsReachAuthority(t *testing.T) {
 w := MustNew([]byte("{\\"schema\\":1,\\"theme\\":\\"classic\\",\\"id\\":\\"test\\",\\"name\\":\\"Test\\",\\"author\\":\\"Tests\\",\\"width\\":36,\\"height\\":36,\\"walls\\":[],\\"spawns\\":[{\\"x\\":4,\\"y\\":4},{\\"x\\":8,\\"y\\":4}]}"))
 a,b := w.Add(),w.Add(); w.Spawn(a); w.Spawn(b)
 if a.HP != 160 || a.State.Equipment.Grenades != 4 || a.State.Equipment.Molotovs != 2 || w.Rules.RespawnTicks != 60 || w.Rules.ScoreLimit != 12 { t.Fatal("spawn/match defaults",a,w.Rules) }
 a.State.X=4; a.State.Y=4; b.State.X=8; b.State.Y=4
 a.State.Equipment=core.NewEquipment("smg","shield"); a.State.Cooldown=0
 core.Step(&a.State,core.Input{Secondary:true},gameconfig.TickSeconds,w.Geometry,nil,&a.Seed,Geometry)
 if a.State.Equipment.Protection != 4 || a.State.Equipment.MeleeDelay != 5 { t.Fatal("shield action",a.State) }
 shielded:=core.Body{HP:200,Shield:true}; core.ApplyDamage(&shielded,80)
 if shielded.HP!=180 { t.Fatal("shield reduction",shielded) }
 a.State.Equipment.Protection=.8; w.Step()
 if a.body.Shield { t.Fatal("inactive shield tail") }
 a.State.Equipment.Action="grenade"; a.State.Equipment.SecondaryActivated=false; w.actions(a,core.Input{},0)
 g:=w.Projectiles[0]
 if g.Expires-w.Tick!=150 || g.Velocity.X!=7 { t.Fatal("grenade launch/fuse",g) }
 a.body.Immune=false; b.body.Immune=false; b.body.Shield=false
 g.Position=core.Vec3{X:8,Y:4,Z:core.Radius}; g.Velocity=core.Vec3{}; g.Expires=w.Tick
 w.updateEntities()
 if b.HP!=70 { t.Fatal("grenade damage",b.HP) }
 f:=w.projectile("flame",a.ID,core.Flight{Position:core.Vec3{X:8,Y:4,Z:core.Radius}})
 f.locked=true
 if f.Expires-w.Tick!=480 || f.nextDamage-w.Tick!=30 { t.Fatal("flame timers",f) }
 w.Tick+=30; w.flame(f)
 if b.HP!=46 { t.Fatal("flame damage",b.HP) }
}
`,
    );
    execFileSync('go', ['test', './backend/server/match'], { cwd: temp, encoding: 'utf8' });
    const help = spawnSync('go', ['run', './backend/cmd/server', '-h'], {
      cwd: temp,
      encoding: 'utf8',
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stderr, /-max-rooms int/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
