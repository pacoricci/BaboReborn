import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AUDIO_SAMPLES,
  LOOP_SAMPLES,
  sampleFiles,
  sampleTakes,
  WEAPON_SAMPLES,
} from '../../src/presentation/audio/audio-catalog';
import type { AudioSample } from '../../src/presentation/audio/audio-catalog';
import { CombatAudio } from '../../src/presentation/audio/combat-audio';

void test('samples are mono PCM, bounded, non-silent and have quiet edges', () => {
  const loops = new Set<string>(LOOP_SAMPLES.map((kind) => AUDIO_SAMPLES[kind].file));
  for (const file of (Object.keys(AUDIO_SAMPLES) as AudioSample[]).flatMap(sampleFiles)) {
    const wav = readFileSync(new URL(`../../public/audio/${file}`, import.meta.url));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt16LE(20), 1);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), 44100);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), wav.length - 44);
    let peak = 0;
    for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
    assert.ok(peak > 5000 && peak < 25000, `${file}: silent or clipped`);
    assert.ok((wav.length - 44) / 88200 <= 8, `${file}: sample too long`);
    if (!loops.has(file)) {
      assert.equal(wav.readInt16LE(44), 0);
      assert.ok(Math.abs(wav.readInt16LE(wav.length - 2)) < 100, `${file}: abrupt tail`);
    } else {
      assert.ok(
        Math.abs(wav.readInt16LE(44) - wav.readInt16LE(wav.length - 2)) < 4000,
        `${file}: loop discontinuity`,
      );
    }
  }
});

void test('all weapons and cues use samples with bounded voices, spatial mix and cleanup', async (t) => {
  const sources: Source[] = [],
    oscillators: Source[] = [],
    gains: Node[] = [],
    pans: Node[] = [];
  class Node {
    value = 0;
    gain = this;
    pan = this;
    frequency = this;
    disconnect() {}
    connect() {}
    setValueAtTime() {}
    setTargetAtTime(value: number) {
      this.value = value;
    }
    exponentialRampToValueAtTime() {}
  }
  class Source extends Node {
    buffer?: AudioBuffer;
    stopped = false;
    deadline = 0;
    loop = false;
    start() {}
    stop(deadline = 0) {
      this.deadline = deadline;
      this.stopped = deadline === 0;
    }
  }
  class Context {
    state = 'running';
    currentTime = 0;
    destination = {};
    resume() {
      return Promise.resolve();
    }
    decodeAudioData() {
      return Promise.resolve({} as AudioBuffer);
    }
    createBufferSource() {
      const s = new Source();
      sources.push(s);
      return s;
    }
    createOscillator() {
      const s = new Source();
      oscillators.push(s);
      return s;
    }
    createGain() {
      const n = new Node();
      gains.push(n);
      return n;
    }
    createStereoPanner() {
      const n = new Node();
      pans.push(n);
      return n;
    }
  }
  const document = { hidden: false };
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true });
  Object.defineProperty(globalThis, 'AudioContext', { value: Context, configurable: true });
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (originalContext) Object.defineProperty(globalThis, 'AudioContext', originalContext);
    else Reflect.deleteProperty(globalThis, 'AudioContext');
  });
  const requested: string[] = [];
  t.mock.method(globalThis, 'fetch', (url: string) => {
    requested.push(url);
    return Promise.resolve(new Response(new Uint8Array([0])));
  });
  const audio = new CombatAudio();
  audio.sample('shield');
  assert.equal(sources.length, 0, 'unloaded cues are skipped');
  audio.volume = 0.4;
  await audio.unlock();
  assert.equal(gains[0]!.value, 0.4);
  audio.volume = 0;
  assert.equal(gains[0]!.value, 0, 'volume changes affect active voices through the master gain');
  audio.volume = 1;
  assert.equal(
    requested.length,
    new Set((Object.keys(AUDIO_SAMPLES) as AudioSample[]).flatMap(sampleFiles)).size,
  );
  audio.setListener({ x: 4, y: 4 });
  audio.sample('shield', { x: 16, y: 4 });
  assert.equal(pans.at(-1)!.value, 0.9);
  assert.equal(gains.at(-1)!.value, (0.135 * AUDIO_SAMPLES.shield.gain) / (1 + 12 * 0.22));
  for (const kind of Object.keys(WEAPON_SAMPLES)) audio.shot(kind);
  audio.cue('death');
  audio.cue('round');
  assert.equal(oscillators.length, 0, 'all cues must use authored samples');
  assert.equal(sources.length, 12, 'every weapon, death and round cue plays');
  audio.enabled = false;
  assert.ok([...sources, ...oscillators].every((s) => s.stopped));
  audio.sample('flag-capture');
  assert.equal(sources.length, 12);
  audio.enabled = true;
  document.hidden = true;
  audio.sample('knives');
  assert.equal(sources.length, 12, 'hidden playback must not queue');
  document.hidden = false;
  for (let i = 0; i < 40; i++) audio.sample('shield');
  assert.equal(sources.length, 40, 'ordinary voices stop at 28');
  audio.sample('ricochet');
  assert.equal(sources.length, 40, 'details do not displace tactical voices');
  for (let i = 0; i < 8; i++) audio.sample('hit');
  assert.equal(sources.length, 44, 'four voices remain reserved for personal combat feedback');
  audio.stop();
  assert.ok(sources.every((s) => s.stopped));
  audio.sample('damage');
  audio.sample('damage');
  audio.sample('damage');
  assert.notEqual(sources.at(-3)!.buffer, sources.at(-2)!.buffer, 'alternate takes rotate');
  assert.equal(sources.at(-3)!.buffer, sources.at(-1)!.buffer, 'take selection wraps');
  const damageTakes = sampleTakes('damage');
  assert.equal(gains.at(-3)!.value, 0.135 * damageTakes[0]!.gain);
  assert.equal(gains.at(-2)!.value, 0.135 * damageTakes[1]!.gain);
  assert.equal(gains.at(-1)!.value, gains.at(-3)!.value, 'gain follows the selected take');
  audio.stop();
  const beforeLoops = Number(sources.length);
  audio.syncLoops([{ key: 'fire', kind: 'fire-loop', position: { x: 16, y: 4 } }]);
  const fire = sources.at(-1)!;
  assert.ok(fire.loop);
  assert.equal(fire.deadline, 0.35, 'stalled rendering expires persistent audio');
  audio.syncLoops([{ key: 'fire', kind: 'fire-loop', position: { x: -8, y: 4 } }]);
  assert.equal(sources.length, beforeLoops + 1, 'updates reuse the loop voice');
  assert.equal(pans.at(-1)!.value, -0.9, 'moving source updates stereo pan');
  audio.syncLoops([]);
  assert.ok(fire.deadline < 0.1, 'removed objects fade out promptly');
  audio.stop();
  const beforeCap = Number(sources.length);
  audio.syncLoops(
    Array.from({ length: 20 }, (_, i) => ({ key: `loop${i}`, kind: 'fire-loop' as const })),
  );
  assert.equal(sources.length - beforeCap, 8, 'loop budget is independent of entity count');
  audio.enabled = false;
  assert.ok(sources.every((s) => s.stopped));
  audio.enabled = true;
  document.hidden = true;
  audio.syncLoops([{ key: 'hidden', kind: 'ambient-loop' }]);
  assert.equal(sources.length - beforeCap, 8, 'hidden loops cannot restart');
  document.hidden = false;
  audio.sustain('photon-loop', { x: 4, y: 4 }, 1);
  assert.equal(sources.at(-1)!.deadline, 1, 'beams have a finite audio-clock lifetime');
  audio.stop();
});
