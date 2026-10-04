import { AUDIO_SAMPLES, sampleFiles, sampleTakes, WEAPON_SAMPLES } from './audio-catalog';
import type { AudioSample, LoopSample } from './audio-catalog';
import { AUDIO } from './limits';
import type { Vec2 } from '../../core/geometry';

export interface AudioLoop {
  key: string;
  kind: LoopSample;
  position?: Vec2;
  level?: number;
}
interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  pan: StereoPannerNode;
  kind: AudioSample;
  sampleGain: number;
  position: Vec2 | undefined;
  level: number;
  cancelled: boolean;
}
const details = new Set<AudioSample>([
  'ricochet',
  'bounce',
  'reload',
  'item-impact',
  'player-impact',
  'roll-stop',
  'photon-impact',
  'flame-impact',
  'shield-hit',
  'fire-end',
]);

// Audio is a presentation adapter, never a gameplay clock.
export class CombatAudio {
  private active = true;
  private disposed = false;
  private level = 1;
  private master?: GainNode;
  private context?: AudioContext;
  private buffers = new Map<string, AudioBuffer>();
  private takes = new Map<AudioSample, number>();
  private loading: Promise<void> | undefined;
  private voices = new Set<Voice>();
  private loops = new Map<string, Voice>();
  private loopVoices = new Set<Voice>();
  private recent = new Map<AudioSample, number>();
  private listener: Vec2 = { x: 0, y: 0 };

  set volume(value: number) {
    this.level = Math.max(0, Math.min(1, value));
    if (this.master) this.master.gain.value = this.level;
  }
  get volume(): number {
    return this.level;
  }
  get enabled(): boolean {
    return this.active;
  }
  set enabled(value: boolean) {
    this.active = value;
    if (!value) this.stop();
  }
  setListener(position: Vec2): void {
    this.listener = position;
    for (const voice of this.loopVoices) this.mix(voice);
  }
  stop(): void {
    for (const voice of this.voices) {
      voice.cancelled = true;
      voice.source.stop();
    }
    this.voices.clear();
    this.loops.clear();
    this.loopVoices.clear();
    this.recent.clear();
  }
  dispose(): void {
    this.disposed = true;
    this.stop();
    this.buffers.clear();
    void this.context?.close().catch(() => {});
  }
  shot(kind?: string, position?: Vec2): void {
    if (kind && Object.hasOwn(WEAPON_SAMPLES, kind))
      this.sample(WEAPON_SAMPLES[kind as keyof typeof WEAPON_SAMPLES], position);
  }
  private mix(voice: Voice): void {
    const dx = voice.position ? voice.position.x - this.listener.x : 0;
    const distance = voice.position ? Math.hypot(dx, voice.position.y - this.listener.y) : 0;
    const gain = (0.135 * voice.sampleGain * voice.level) / (1 + distance * 0.22);
    if (voice.source.loop)
      voice.gain.gain.setTargetAtTime(gain, this.context!.currentTime, AUDIO.loopFadeSeconds);
    else voice.gain.gain.value = gain;
    voice.pan.pan.value = voice.position ? Math.max(-0.9, Math.min(0.9, dx / 12)) : 0;
  }
  private start(kind: AudioSample, position?: Vec2, loop = false, level = 1): Voice | undefined {
    const ctx = this.context;
    if (this.disposed || !this.enabled || document.hidden || ctx?.state !== 'running') return;
    const samples = sampleTakes(kind),
      take = this.takes.get(kind) ?? 0;
    const sample = samples[take % samples.length]!;
    const buffer = this.buffers.get(sample.file);
    if (!buffer || (loop && this.loopVoices.size >= AUDIO.loops)) return;
    if (details.has(kind) && this.voices.size >= AUDIO.detailVoices) return;
    if (
      this.voices.size >=
      (kind === 'hit' || kind === 'damage' ? AUDIO.combatVoices : AUDIO.ordinaryVoices)
    )
      return;
    this.takes.set(kind, (take + 1) % samples.length);
    const voice: Voice = {
      source: ctx.createBufferSource(),
      gain: ctx.createGain(),
      pan: ctx.createStereoPanner(),
      kind,
      sampleGain: sample.gain,
      position,
      level,
      cancelled: false,
    };
    voice.source.buffer = buffer;
    voice.source.loop = loop;
    voice.source.connect(voice.gain);
    voice.gain.connect(voice.pan);
    voice.pan.connect(this.master!);
    if (loop) voice.gain.gain.value = 0;
    this.mix(voice);
    this.voices.add(voice);
    if (loop) this.loopVoices.add(voice);
    voice.source.onended = () => {
      this.voices.delete(voice);
      this.loopVoices.delete(voice);
      for (const [key, current] of this.loops) if (current === voice) this.loops.delete(key);
      voice.source.disconnect();
      voice.gain.disconnect();
      voice.pan.disconnect();
    };
    voice.source.start();
    return voice;
  }
  sample(kind: AudioSample, position?: Vec2): void {
    const now = this.context?.currentTime ?? 0;
    if (details.has(kind) && now - (this.recent.get(kind) ?? -Infinity) < AUDIO.contactGapSeconds)
      return;
    if (this.start(kind, position)) this.recent.set(kind, now);
  }
  // Finite beams stop on the audio clock even if rendering or the network stalls.
  sustain(kind: LoopSample, position: Vec2, seconds: number): void {
    const voice = this.start(kind, position, true);
    if (voice) {
      const cleanup = voice.source.onended;
      voice.source.onended = (event) => {
        cleanup?.call(voice.source, event);
        if (!voice.cancelled && kind === 'photon-loop') this.sample('photon-end', position);
      };
      voice.source.stop(this.context!.currentTime + seconds);
    }
  }
  syncLoops(wanted: readonly AudioLoop[]): void {
    if (!this.enabled || document.hidden) {
      this.stop();
      return;
    }
    const keys = new Set(wanted.map((loop) => loop.key));
    for (const [key, voice] of this.loops) {
      if (keys.has(key)) continue;
      voice.gain.gain.setTargetAtTime(0, this.context!.currentTime, AUDIO.loopFadeSeconds);
      voice.source.stop(this.context!.currentTime + AUDIO.loopFadeSeconds * 3);
      this.loops.delete(key);
    }
    for (const loop of wanted) {
      let voice = this.loops.get(loop.key);
      if (!voice) {
        voice = this.start(loop.kind, loop.position, true, loop.level ?? 1);
        if (!voice) continue;
        this.loops.set(loop.key, voice);
      }
      voice.position = loop.position;
      voice.level = loop.level ?? 1;
      this.mix(voice);
      // Repeated stop calls replace the deadline. Hidden/frozen tabs cannot drone forever.
      voice.source.stop(this.context!.currentTime + AUDIO.loopLeaseSeconds);
    }
  }
  async unlock(): Promise<void> {
    if (this.disposed || !this.enabled) return;
    try {
      this.context ??= new AudioContext();
      if (!this.master) {
        this.master = this.context.createGain();
        this.master.gain.value = this.level;
        this.master.connect(this.context.destination);
      }
      await this.context.resume();
      if (this.disposed) return;
      const ctx = this.context;
      this.loading ??= Promise.all(
        [...new Set((Object.keys(AUDIO_SAMPLES) as AudioSample[]).flatMap(sampleFiles))].map(
          async (file) => {
            if (this.buffers.has(file)) return;
            const response = await fetch(`/audio/${file}`);
            if (!response.ok) throw new Error('Audio unavailable');
            const decoded = await ctx.decodeAudioData(await response.arrayBuffer());
            if (!this.disposed) this.buffers.set(file, decoded);
          },
        ),
      )
        .then(() => undefined)
        .catch(() => {
          this.loading = undefined;
        });
      await this.loading;
    } catch {
      /* Audio is optional; controls must remain usable. */
    }
  }
  cue(kind: 'hit' | 'death' | 'round'): void {
    this.sample(kind);
  }
}
