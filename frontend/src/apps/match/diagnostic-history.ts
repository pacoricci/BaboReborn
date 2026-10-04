import { CorrectionHistory } from './correction-history';
import type { PredictionObserver } from '../../prediction/diagnostics';

export type DiagnosticKind =
  | 'collection'
  | 'frame'
  | 'snapshot'
  | 'installation'
  | 'resync'
  | 'failure'
  | 'closed'
  | 'probe'
  | 'delivery'
  | 'receipt'
  | 'backpressure'
  | 'visibility';
export type DiagnosticData = Record<string, string | number | boolean | null>;
interface Sample {
  atMs: number;
  kind: DiagnosticKind;
  data: DiagnosticData;
}

// Owned by the page lifecycle, so replacement sessions cannot erase an incident.
// A ring avoids shifting thousands of samples in the rendering hot path.
export class MatchDiagnostics {
  private corrections = new CorrectionHistory();

  predictionObserver(atMs: number, generation: number): PredictionObserver | undefined {
    return this.collecting
      ? (data) => {
          if (this.collecting) this.corrections.record(atMs, generation, data);
        }
      : undefined;
  }

  private samples: (Sample | undefined)[] = [];
  private collecting = false;
  startedAtMs: number | null = null;
  private stoppedAtMs: number | null = null;
  readonly capacity = 24000;
  private head = 0;
  private size = 0;
  private capacityEvictions = 0;
  readonly windowMs = 120_000;

  get enabled(): boolean {
    return this.collecting;
  }

  setEnabled(enabled: boolean, now: number): void {
    if (enabled === this.collecting) return;
    if (enabled) {
      if (!this.samples.length) this.samples = new Array<Sample | undefined>(this.capacity);
      this.collecting = true;
      this.startedAtMs = now;
      this.stoppedAtMs = null;
      this.record('collection', now, { enabled: true });
    } else {
      this.record('collection', now, { enabled: false });
      this.collecting = false;
      this.stoppedAtMs = now;
    }
  }

  record(kind: DiagnosticKind, atMs: number, data: DiagnosticData): void {
    if (!this.collecting) return;
    this.prune(atMs);
    if (['collection', 'installation', 'resync', 'failure', 'closed', 'visibility'].includes(kind))
      this.corrections.boundary(
        kind,
        atMs,
        kind === 'installation' || (kind === 'collection' && data.enabled === true),
      );
    if (this.size === this.samples.length) {
      this.head = (this.head + 1) % this.samples.length;
      this.size--;
      this.capacityEvictions++;
    }
    this.samples[(this.head + this.size) % this.samples.length] = { kind, atMs, data };
    this.size++;
  }

  private prune(now: number): void {
    this.corrections.prune(now);
    while (this.size && this.samples[this.head]!.atMs < now - this.windowMs) {
      this.samples[this.head] = undefined;
      this.head = (this.head + 1) % this.samples.length;
      this.size--;
    }
  }

  snapshot(now: number) {
    if (this.collecting) this.prune(now);
    const samples = Array.from(
      { length: this.size },
      (_, i) => this.samples[(this.head + i) % this.samples.length]!,
    );
    let starvedFrames = 0;
    let starvationEpisodes = 0;
    let wasStarved = false;
    for (const sample of samples) {
      if (sample.kind === 'installation' || sample.kind === 'collection') wasStarved = false;
      if (sample.kind !== 'frame') continue;
      const starved = sample.data.active === true && sample.data.interpolationStarved === true;
      if (starved) {
        starvedFrames++;
        if (!wasStarved) starvationEpisodes++;
      }
      wasStarved = starved;
    }
    return {
      collecting: this.collecting,
      startedAtMs: this.startedAtMs,
      stoppedAtMs: this.stoppedAtMs,
      corrections: this.corrections.snapshot(),
      activeInterpolation: { starvedFrames, starvationEpisodes },
      clock: 'performance.now',
      exportedAtMs: now,
      windowMs: this.windowMs,
      capacity: this.capacity,
      capacityEvictions: this.capacityEvictions,
      samples,
    };
  }
}
