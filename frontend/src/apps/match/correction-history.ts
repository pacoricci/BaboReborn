import type { PredictionTrace } from '../../prediction/diagnostics';
import { PREDICTION_TRACE_LIMITS } from '../../prediction/diagnostics';

const EPISODE_RETENTION_MS = 120_000;

interface TraceSample {
  atMs: number;
  generation: number;
  data: PredictionTrace;
}
interface Episode {
  triggerAtMs: number;
  endAtMs: number;
  observedThroughMs: number;
  triggers: number;
  maxCorrection: number;
  omittedSamples: number;
  interrupted: string | null;
  samples: TraceSample[];
}

// Detailed traces have their own budget, so replay cannot evict frame/network evidence.
export class CorrectionHistory {
  readonly thresholdCells = 0.01;
  readonly contextMs = 1000;
  readonly recentCapacity = 256;
  readonly episodeCapacity = 8;
  readonly episodeSampleCapacity = 512;
  private recent: (TraceSample | undefined)[] = new Array<TraceSample | undefined>(
    this.recentCapacity,
  );
  private head = 0;
  private size = 0;
  private episodes: Episode[] = [];
  private active: Episode | undefined;
  private episodeEvictions = 0;
  private recentCapacityEvictions = 0;

  boundary(reason: string, now: number, clearRecent = true): void {
    if (clearRecent) {
      this.recent.fill(undefined);
      this.head = this.size = 0;
    }
    if (this.active && now < this.active.endAtMs) this.active.interrupted = reason;
    else if (this.active) this.active.observedThroughMs = now;
    this.active = undefined;
  }

  record(atMs: number, generation: number, data: PredictionTrace): void {
    this.prune(atMs);
    const sample = { atMs, generation, data };
    if (this.size === this.recentCapacity) {
      this.dropRecent();
      this.recentCapacityEvictions++;
    }
    this.recent[(this.head + this.size) % this.recentCapacity] = sample;
    this.size++;
    const correction = data.kind === 'reconcile' ? data.correction : null;
    if (this.active && atMs > this.active.endAtMs) {
      this.active.observedThroughMs = atMs;
      this.active = undefined;
    }
    if (this.active) {
      this.active.observedThroughMs = atMs;
      if (this.active.samples.length < this.episodeSampleCapacity) this.active.samples.push(sample);
      else this.active.omittedSamples++;
    }
    if (correction === null || correction <= this.thresholdCells) return;
    if (this.active) {
      this.active.triggers++;
      this.active.maxCorrection = Math.max(this.active.maxCorrection, correction);
      return;
    }
    // Fixed windows prevent continuous corrections from extending one episode forever.
    this.active = {
      triggerAtMs: atMs,
      endAtMs: atMs + this.contextMs,
      observedThroughMs: atMs,
      triggers: 1,
      maxCorrection: correction,
      omittedSamples: 0,
      interrupted: null,
      samples: this.recentSamples(),
    };
    if (this.episodes.length === this.episodeCapacity) {
      this.episodes.shift();
      this.episodeEvictions++;
    }
    this.episodes.push(this.active);
  }

  private dropRecent(): void {
    this.recent[this.head] = undefined;
    this.head = (this.head + 1) % this.recentCapacity;
    this.size--;
  }

  private recentSamples(): TraceSample[] {
    return Array.from(
      { length: this.size },
      (_, i) => this.recent[(this.head + i) % this.recentCapacity]!,
    );
  }

  prune(now: number): void {
    while (this.size && this.recent[this.head]!.atMs < now - this.contextMs) this.dropRecent();
    while (this.episodes.length && this.episodes[0]!.endAtMs < now - EPISODE_RETENTION_MS)
      this.episodes.shift();
    if (this.active && !this.episodes.includes(this.active)) this.active = undefined;
  }

  snapshot() {
    return {
      thresholdCells: this.thresholdCells,
      contextMs: this.contextMs,
      recentCapacity: this.recentCapacity,
      episodeCapacity: this.episodeCapacity,
      episodeSampleCapacity: this.episodeSampleCapacity,
      traceLimits: PREDICTION_TRACE_LIMITS,
      episodeEvictions: this.episodeEvictions,
      recentCapacityEvictions: this.recentCapacityEvictions,
      recent: this.recentSamples(),
      episodes: this.episodes.map((e) => ({
        ...e,
        afterComplete: e.observedThroughMs >= e.endAtMs && !e.interrupted,
        samples: [...e.samples],
      })),
    };
  }
}
