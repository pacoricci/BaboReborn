import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG } from '../../../devtools/browser/workshop/catalog';
import { MODEL_NAMES } from '../../src/presentation/assets/model-catalog';
import { PRIMARIES, SECONDARIES } from '../../src/core/equipment';

void test('workshop exposes every fixed game model and every approved equipment option', () => {
  const ids = CATALOG.map((asset) => asset.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate IDs make selection ambiguous');
  for (const id of [...MODEL_NAMES, ...PRIMARIES, ...SECONDARIES, 'grenade', 'molotov'])
    assert.ok(ids.includes(id), `Missing preview for ${id}`);
  assert.deepEqual(
    CATALOG.filter((asset) => asset.type === 'GLB model')
      .map((asset) => asset.id)
      .sort(),
    [...MODEL_NAMES].sort(),
    'procedural effects must not claim to load nonexistent models',
  );
});
