import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultBindings, defaultOptions, parseOptions } from '../../src/player/game-options';
import { RenderClock } from '../../src/apps/match/render-clock';

void test('missing preferences use defaults; corrupt options cannot disable controls or escape limits', () => {
  assert.deepEqual(parseOptions({}), defaultOptions);
  for (const up of ['KeyH', 'KeyM']) {
    assert.deepEqual(
      parseOptions({ bindings: { ...defaultBindings, up } }).bindings,
      defaultBindings,
    );
  }
  assert.deepEqual(
    parseOptions({ bindings: { ...defaultBindings, up: 'KeyS' } }).bindings,
    defaultBindings,
  );
  const parsed = parseOptions({
    volume: -20,
    fps: 1,
    crosshairSize: Infinity,
    crosshairColor: 'red',
  });
  assert.equal(parsed.volume, 0);
  assert.equal(parsed.fps, 0);
  assert.equal(parsed.crosshairSize, 17);
  assert.equal(parsed.crosshairColor, defaultOptions.crosshairColor);
  assert.equal(parseOptions({ bindings: { ...defaultBindings, up: 'KeyZ' } }).bindings.up, 'KeyZ');
});
void test('render cap maintains cadence through jitter, pauses and live changes', () => {
  const clock = new RenderClock();
  const draws: number[] = [];
  for (let frame = 0; frame < 600; frame++) {
    const now = (frame * 1000) / 60 + (frame % 2 ? -0.2 : 0.2);
    if (clock.step(now, 30) !== null) draws.push(now);
  }
  assert.equal(draws.length, 300);
  assert.ok(draws.slice(1).every((time, index) => time - draws[index]! > 32));
  assert.equal(clock.step(20000, 30), 0.1);
  assert.equal(clock.step(20001, 30), null);
  assert.notEqual(clock.step(20002, 0), null);
  assert.notEqual(clock.step(20003, 0), null);
  assert.notEqual(clock.step(20004, 60), null);
  assert.equal(clock.step(20005, 60), null);
});
