import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isArenaMap } from '../../src/maps/validation';
import { MAX_DECALS } from '../../src/maps/decals';
import { newMap, parseMap, exportMap, resizeMap, inspectMap } from '../../src/apps/editor/model';
import { placeDecal } from '../../src/apps/editor/decals';
import { EditorApplication } from '../../src/apps/editor/application';
import { bundledCatalog } from '../support/content';
import { parseCatalog, parseDecal } from '../../src/content/validation';
import { createCollisionGrid } from '../../src/core/grid';

const decal = { asset: 'oil', x: 8, y: 8, w: 2, h: 2, angle: 0, opacity: 0.6 };
void test('shared Go/TypeScript decal cases and format boundaries agree', () => {
  const cases = JSON.parse(readFileSync('content/decal-validation.json', 'utf8')) as {
    patch: Record<string, unknown>;
    remove?: string[];
    valid: boolean;
  }[];
  for (const [i, c] of cases.entries()) {
    const value: Record<string, unknown> = { ...decal, ...c.patch };
    for (const key of c.remove ?? []) delete value[key];
    assert.equal(isArenaMap({ ...newMap(16, 16), decals: [value] }), c.valid, `case ${i}`);
  }
  const map = { ...newMap(16, 16), decals: [decal] };
  assert.equal(isArenaMap({ ...map, schema: 2 }), false);
  assert.equal(isArenaMap({ ...map, decals: null }), false);
  assert.equal(
    isArenaMap({ ...map, decals: Array.from({ length: MAX_DECALS + 1 }, () => decal) }),
    false,
  );
  assert.equal(isArenaMap({ ...map, decals: [{ ...decal, angle: Infinity }] }), false);
  assert.deepEqual(parseMap(exportMap(map)), map);
  assert.ok(isArenaMap(map));
});
void test('catalog validates reusable decal IDs and immutable image references', () => {
  assert.deepEqual(
    parseCatalog(bundledCatalog)
      .decals.map((asset) => asset.id)
      .sort(),
    ['arrow', 'crack', 'marking', 'oil', 'rust', 'scorch', 'skid'],
  );
  assert.throws(() =>
    parseCatalog({
      ...bundledCatalog,
      decals: [...bundledCatalog.decals, bundledCatalog.decals[0]],
    }),
  );
  assert.throws(() => parseCatalog({ ...bundledCatalog, decals: null }));
  for (const texture of [
    '../texture.png',
    'https://outside.test/texture.png',
    '/texture.png',
    null,
  ])
    assert.throws(() =>
      parseDecal({ schema: 1, id: 'oil', name: 'Oil', author: 'Tests', texture }),
    );
});
void test('decal dragging is one history entry; properties, duplication, import and removal round trip', async () => {
  let exported = '';
  const app = new EditorApplication(bundledCatalog, [], {
    download: (_name, source) => {
      exported = source;
    },
    prepareTrial: () => Promise.reject(new Error('unused')),
  });
  const original = app.snapshot().map;
  app.selectDecalAsset('oil');
  app.beginDecalDrag({ x: 8, y: 8 });
  app.moveDecal({ x: 9, y: 8 });
  app.moveDecal({ x: 10, y: 9 });
  app.finishStroke();
  assert.equal(app.snapshot().map.decals?.[0]?.x, 10);
  app.undo();
  assert.deepEqual(app.snapshot().map, original);
  assert.equal(app.snapshot().canUndo, false);
  app.redo();
  app.beginDecalDrag({ x: 10, y: 9 });
  app.finishStroke();
  app.updateDecal({ w: 3, angle: Math.PI / 4, opacity: 0.4 });
  app.duplicateDecal();
  assert.equal(app.snapshot().map.decals?.length, 2);
  app.deleteDecal();
  assert.equal(app.snapshot().map.decals?.length, 1);
  app.undo();
  assert.equal(app.snapshot().map.decals?.length, 2);
  app.save();
  const saved = parseMap(exported);
  assert.equal(saved.decals?.[0]?.opacity, 0.4);
  app.newDocument();
  await app.openFile({
    name: 'saved.json',
    size: exported.length,
    text: () => Promise.resolve(exported),
  });
  assert.deepEqual(app.snapshot().map, saved);
  await app.openFile({
    name: 'unknown.json',
    size: 100,
    text: () =>
      Promise.resolve(JSON.stringify({ ...saved, decals: [{ ...decal, asset: 'missing' }] })),
  });
  assert.deepEqual(app.snapshot().map, saved);
  assert.match(app.snapshot().notice, /Unknown decal/);
  app.dispose();
});
void test('decorations leave collision geometry intact and cropped art is retained for repair', () => {
  const base = newMap(16, 16);
  const decorated = placeDecal(base, { ...decal, x: 14 });
  assert.deepEqual(
    createCollisionGrid({ x: 0, y: 0, w: 16, h: 16 }, base.walls),
    createCollisionGrid({ x: 0, y: 0, w: 16, h: 16 }, decorated.walls),
  );
  const resized = resizeMap(decorated, 12, 16);
  assert.deepEqual(resized.decals, decorated.decals);
  assert.ok(inspectMap(resized).errors.length);
  assert.throws(() => exportMap(resized));
});
