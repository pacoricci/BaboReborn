import assert from 'node:assert/strict';
import test from 'node:test';
import { updateSniperScope } from '../../src/apps/match/sniper-scope';
import type { ArenaView } from '../../src/presentation/view';

void test('scope follows the cursor and clears on unscoping, death, menu and weapon swap', () => {
  const properties = new Map<string, string>();
  const overlay = {
    hidden: true,
    style: { opacity: '', setProperty: (key: string, value: string) => properties.set(key, value) },
  };
  const element = overlay as unknown as HTMLElement;
  const view: ArenaView = {
    player: { x: 0, y: 0, angle: 0, primary: 'sniper', visible: true },
    actors: [],
  };
  const pointer = { x: 750, y: 40 };
  updateSniperScope(element, view, true, 10, pointer);
  assert.equal(overlay.hidden, true);
  updateSniperScope(element, view, true, 11, pointer);
  assert.equal(overlay.hidden, false);
  assert.equal(overlay.style.opacity, '0.5');
  assert.equal(properties.get('--scope-x'), '750px');
  assert.equal(properties.get('--scope-y'), '40px');
  updateSniperScope(element, view, true, 12, { x: 30, y: 550 });
  assert.equal(overlay.style.opacity, '1');
  assert.equal(properties.get('--scope-x'), '30px');
  for (const [player, active, height] of [
    [{ ...view.player, visible: false }, true, 12],
    [{ ...view.player, primary: 'smg' }, true, 12],
    [view.player, false, 12],
    [view.player, true, 9],
  ] as const) {
    updateSniperScope(element, view, true, 12, pointer);
    updateSniperScope(element, { ...view, player }, active, height, pointer);
    assert.equal(overlay.hidden, true);
  }
});
