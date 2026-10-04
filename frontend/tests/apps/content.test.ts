import { geometryWalls } from '../../src/maps/types';
import { mapImpact } from '../../src/core/ballistics';
import test from 'node:test';
import assert from 'node:assert/strict';
import { bundledCatalog, skins, themes } from '../support/content';
import { parseCatalog, parseSkin, parseTheme } from '../../src/content/validation';
import {
  compactWalls,
  newMap,
  paint,
  resizeMap,
  exportMap,
  parseMap,
  EditorHistory,
} from '../../src/apps/editor/model';
import { createCollisionGrid } from '../../src/core/grid';
void test('catalog resolves generated image URLs and accepts user-authored IDs', () => {
  assert.equal(parseCatalog(bundledCatalog).skins.length, 15);
  assert.equal(parseSkin({ ...skins[0], id: 'user-pattern' }).id, 'user-pattern');
  for (const mask of ['../mask.png', 'https://example.com/a.png', '/mask.png', 'a\\mask.png'])
    assert.throws(() => parseSkin({ ...skins[0], mask }));
  assert.throws(() =>
    parseCatalog({ ...bundledCatalog, skins: [...bundledCatalog.skins, bundledCatalog.skins[0]] }),
  );
  const t = themes[0]!;
  assert.throws(() => parseTheme({ ...t, defaultMaterial: 'missing' }));
  assert.throws(() =>
    parseTheme({
      ...t,
      materials: Object.fromEntries(
        Array.from({ length: 9 }, (_, i) => [`m${i}`, t.materials.standard]),
      ),
    }),
  );
  assert.throws(() =>
    parseTheme({ ...t, materials: { standard: { ...t.materials.standard, tile: 0 } } }),
  );
});
void test('wall variants survive editing without changing collisions', () => {
  let a = paint(newMap(16, 16), { x: 5, y: 5 }, 'wall', 3, 'none', 'stone');
  a = paint(a, { x: 6, y: 5 }, 'wall', 3, 'none', 'brick');
  assert.equal(compactWalls(a).walls.filter((w) => w.y === 5).length, 2);
  const b = paint(a, { x: 5, y: 5 }, 'material', 1, 'none', 'brick');
  assert.equal(compactWalls(b).walls.filter((w) => w.y === 5).length, 1);
  assert.deepEqual(
    createCollisionGrid({ x: 0, y: 0, w: 16, h: 16 }, a.walls),
    createCollisionGrid({ x: 0, y: 0, w: 16, h: 16 }, b.walls),
  );
  assert.deepEqual(
    geometryWalls(a).sort((a, b) => a.y - b.y || a.x - b.x),
    geometryWalls(b).sort((a, b) => a.y - b.y || a.x - b.x),
  );
  assert.ok(geometryWalls(a).every((w) => !Object.hasOwn(w, 'material')));
  assert.deepEqual(
    mapImpact({ x: 3, y: 5.5, z: 0.25 }, { x: 9, y: 5.5, z: 0.25 }, geometryWalls(a), 0.7),
    mapImpact({ x: 3, y: 5.5, z: 0.25 }, { x: 9, y: 5.5, z: 0.25 }, geometryWalls(b), 0.7),
  );
  const history = new EditorHistory(a);
  history.change(b);
  history.finish();
  history.undo();
  assert.deepEqual(history.current, a);
  history.redo();
  assert.deepEqual(history.current, compactWalls(b));
  assert.deepEqual(parseMap(exportMap(b)), b);
  assert.ok(resizeMap(a, 20, 20).walls.some((w) => w.material === 'stone'));
  const mirrored = paint(newMap(16, 16), { x: 5, y: 5 }, 'wall', 4, 'both', 'brick');
  assert.equal(mirrored.walls.filter((w) => w.material === 'brick' && w.height === 4).length, 4);
  const cropped = resizeMap(
    { ...newMap(16, 16), walls: [{ x: 5, y: 5, w: 5, h: 5, height: 4, material: 'brick' }] },
    8,
    8,
  );
  assert.deepEqual(
    cropped.walls.find((w) => w.material === 'brick'),
    {
      x: 5,
      y: 5,
      w: 2,
      h: 2,
      height: 4,
      material: 'brick',
    },
  );
  const cut = paint(mirrored, { x: 5, y: 5 }, 'floor', 1, 'none');
  assert.equal(cut.walls.filter((w) => w.material === 'brick' && w.height === 4).length, 3);
});

void test('material painting preserves overlapping heights and projectile cover', () => {
  const base = newMap(16, 16);
  const overlap = [
    { x: 4, y: 5, w: 3, h: 1, height: 1, material: 'stone' },
    { x: 5, y: 4, w: 1, h: 3, height: 4, material: 'stone' },
  ];
  for (const layers of [overlap, [...overlap].reverse()]) {
    const before = parseMap(JSON.stringify({ ...base, walls: [...base.walls, ...layers] }));
    const after = compactWalls(paint(before, { x: 5, y: 5 }, 'material', 3, 'none', 'brick'));
    const at = (map: typeof before, x: number, y: number) =>
      map.walls.filter((w) => x >= w.x && x < w.x + w.w && y >= w.y && y < w.y + w.h);
    for (let y = 0; y < before.height; y++)
      for (let x = 0; x < before.width; x++) {
        assert.deepEqual(
          at(after, x, y)
            .map((w) => w.height)
            .sort(),
          at(before, x, y)
            .map((w) => w.height)
            .sort(),
        );
        assert.deepEqual(
          at(after, x, y)
            .map((w) => w.material)
            .sort(),
          at(before, x, y)
            .map((w) => (x === 5 && y === 5 ? 'brick' : w.material))
            .sort(),
        );
      }
    const from = { x: 3, y: 5.5, z: 2 },
      to = { x: 8, y: 5.5, z: 2 };
    const impact = mapImpact(from, to, geometryWalls(before), 0.7);
    assert.equal(impact.point.x, 5);
    assert.deepEqual(mapImpact(from, to, geometryWalls(after), 0.7), impact);
    assert.deepEqual(parseMap(exportMap(after)), after);
  }
});

void test('shared Go/TypeScript manifest cases agree', async () => {
  const { readFileSync } = await import('node:fs');
  const cases: { kind: 'skin' | 'theme'; patch: Record<string, unknown>; valid: boolean }[] =
    JSON.parse(readFileSync('content/content-validation.json', 'utf8')) as {
      kind: 'skin' | 'theme';
      patch: Record<string, unknown>;
      valid: boolean;
    }[];
  for (const c of cases) {
    const value = {
      ...(c.kind === 'skin'
        ? skins.find((s) => s.id === 'geometric')
        : themes.find((t) => t.id === 'classic')),
      ...c.patch,
    };
    const parse = () => (c.kind === 'skin' ? parseSkin(value) : parseTheme(value));
    if (c.valid) assert.doesNotThrow(parse);
    else assert.throws(parse);
  }
});

void test('central catalog validates map references and resolves CDN files without changing paths', async () => {
  const { installContent, contentURL } = await import('../../src/content/runtime');
  const catalog = parseCatalog({ ...bundledCatalog, fileOrigin: 'https://cdn.example.test' });
  installContent(catalog, 'https://portal.example.test');
  try {
    assert.equal(
      contentURL(catalog.skins[0]!.mask),
      `https://cdn.example.test${catalog.skins[0]!.mask}`,
    );
    assert.equal(
      contentURL(catalog.maps[0]!.file),
      `https://cdn.example.test${catalog.maps[0]!.file}`,
    );
    for (const fileOrigin of [
      'http://cdn.example.test',
      'https://cdn.example.test/path',
      'https://user:pass@cdn.example.test',
    ])
      assert.throws(() => parseCatalog({ ...catalog, fileOrigin }));
    assert.throws(() => parseCatalog({ ...catalog, schema: 2 }));
    assert.throws(() => parseCatalog({ ...catalog, maps: [] }));
    assert.throws(() => parseCatalog({ ...catalog, maps: [catalog.maps[0], catalog.maps[0]] }));
    assert.throws(() =>
      parseCatalog({
        ...catalog,
        maps: [{ ...catalog.maps[0], file: 'https://community.test/map.json' }],
      }),
    );
  } finally {
    installContent(bundledCatalog);
  }
});
