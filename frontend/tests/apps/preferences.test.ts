import { createComputed, createRoot } from 'solid-js';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createPreferences } from '../../src/player/preferences';
import { defaultSettings } from '../../src/player/player-preferences';
import { DEFAULT_APPEARANCE } from '../../src/player/appearance';
import { bundledCatalog } from '../support/content';

function fixture(t: TestContext, saved = true) {
  const writes: unknown[] = [];
  const app = createRoot((dispose) => {
    t.after(dispose);
    return createPreferences(
      {
        settings: { ...defaultSettings },
        appearance: { ...DEFAULT_APPEARANCE },
        unavailableSkin: true,
        characterFeedback: '',
        optionsFeedback: '',
      },
      bundledCatalog,
      {
        saveSettings: (value) => {
          writes.push(value);
          return saved;
        },
        saveAppearance: (value) => {
          writes.push(value);
          return saved;
        },
      },
    );
  });
  return { app, writes };
}
void test('preferences validate before saving and preserve earlier persistence values', (t) => {
  const { app, writes } = fixture(t);
  assert.notEqual(app.nickname('   '), '');
  assert.notEqual(app.nickname('😃'), '');
  app.primary('unknown');
  app.secondary('unknown');
  assert.deepEqual(writes, []);
  assert.equal(app.nickname('  Player One  '), '');
  app.primary('sniper');
  app.secondary('minibot');
  app.options({ sound: false });
  assert.deepEqual(app.state.settings, {
    ...defaultSettings,
    nickname: 'Player One',
    primary: 'sniper',
    secondary: 'minibot',
    sound: false,
  });
  assert.deepEqual(writes[0], { ...defaultSettings, nickname: 'Player One' });
  assert.equal(app.state.optionsFeedback, 'Saved.');
});
void test('appearance only saves installed catalog selections, not local preview-only skins', (t) => {
  const { app, writes } = fixture(t);
  app.appearance({ ...DEFAULT_APPEARANCE, template: 'preview-only' });
  assert.equal(writes.length, 0);
  const skin = bundledCatalog.skins[0]!;
  app.appearance({ template: skin.id, colors: ['#000000', '#ffffff', '#123456'] });
  assert.equal(writes.length, 1);
  assert.equal(app.state.appearance.template, skin.id);
  assert.equal(app.state.unavailableSkin, false);
});
void test('storage failures are explicit for Character, appearance and Options without discarding current edits', (t) => {
  const { app } = fixture(t, false);
  app.nickname('Local Name');
  assert.match(app.state.characterFeedback, /Could not save/);
  assert.equal(app.state.settings.nickname, 'Local Name');
  app.appearance({ ...DEFAULT_APPEARANCE });
  assert.match(app.state.characterFeedback, /Could not save/);
  app.options({ sound: false });
  assert.match(app.state.optionsFeedback, /Could not save/);
  assert.equal(app.state.settings.sound, false);
});
void test('preference views react directly and release their Solid owners independently', (t) => {
  const { app } = fixture(t);
  let updates = 0;
  const stop = createRoot((dispose) => {
    createComputed(() => {
      void app.state.settings.sound;
      updates++;
    });
    return dispose;
  });
  app.options({ sound: false });
  stop();
  app.options({ sound: true });
  assert.equal(updates, 2);
});

void test('saved feedback restarts on edits, keeps errors', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { app } = fixture(t);
  app.nickname('One');
  assert.equal(app.state.characterFeedback, 'Saved.');
  t.mock.timers.tick(2000);
  app.primary('sniper');
  t.mock.timers.tick(1000);
  assert.equal(app.state.characterFeedback, 'Saved.');
  t.mock.timers.tick(1500);
  assert.equal(app.state.characterFeedback, '');
  app.options({ sound: false });
  t.mock.timers.tick(2500);
  assert.equal(app.state.optionsFeedback, '');
  const failure = fixture(t, false).app;
  failure.nickname('One');
  t.mock.timers.tick(3000);
  assert.match(failure.state.characterFeedback, /Could not save/);
});

void test('advanced nickname edits validate and save name and colors together', (t) => {
  const { app, writes } = fixture(t);
  assert.notEqual(app.nickname('AB', 'red'), '');
  assert.deepEqual(writes, []);
  assert.equal(app.nickname('AB', 'ff334455ddff'), '');
  assert.equal(writes.length, 1);
  assert.equal(app.state.settings.nickname, 'AB');
  assert.equal(app.state.settings.nicknameColors, 'ff334455ddff');
  assert.equal(app.nickname('AXB'), '');
  assert.equal(app.state.settings.nicknameColors, 'ff3344------55ddff');
  assert.equal(app.nickname('AXB', ''), '');
  assert.equal(app.state.settings.nicknameColors, '');
});
