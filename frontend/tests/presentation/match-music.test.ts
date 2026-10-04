import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchMusic } from '../../src/presentation/audio/match-music';

void test('match music follows entry, settings, visibility and teardown without restarting', async (t) => {
  const tracks: Track[] = [];
  class Track {
    loop = false;
    preload = '';
    volume = 1;
    paused = true;
    currentTime = 42;
    reject = false;
    released = false;
    constructor(public src: string) {
      tracks.push(this);
    }
    play() {
      if (this.reject) return Promise.reject(new Error('Autoplay blocked'));
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
    removeAttribute() {
      this.src = '';
    }
    load() {
      this.released = true;
    }
  }
  const document = { hidden: false };
  for (const [key, value] of Object.entries({ Audio: Track, document })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const music = new MatchMusic();
  const track = tracks[0]!;
  music.configure(true, 0.5);
  assert.equal(track.paused, true, 'settings alone do not start the track');
  assert.equal(track.preload, 'none');
  assert.equal(track.loop, true);
  assert.equal(track.volume, 0.5);
  track.reject = true;
  music.start();
  await Promise.resolve();
  assert.equal(track.paused, true);
  track.reject = false;
  music.start();
  assert.equal(track.paused, false, 'a later gesture retries blocked playback');
  music.configure(false, 1);
  assert.equal(track.paused, true);
  music.configure(true, 0);
  assert.equal(track.paused, true);
  music.configure(true, 1);
  assert.equal(track.paused, false);
  document.hidden = true;
  music.sync();
  assert.equal(track.paused, true);
  document.hidden = false;
  music.sync();
  assert.equal(track.paused, false);
  assert.equal(track.currentTime, 42, 'resume preserves playback position');
  music.stop();
  music.configure(true, 1);
  music.sync();
  assert.equal(track.paused, true, 'disconnect cannot be undone by settings or visibility');
  music.dispose();
  assert.equal(track.src, '');
  assert.equal(track.released, true);
});
