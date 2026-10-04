// Schedule drawing only; simulation and input keep the browser's full cadence.
export class RenderClock {
  private previous: number | undefined;
  private next = 0;
  private limit = 0;
  step(now: number, fps: number): number | null {
    if (this.limit !== fps) {
      this.limit = fps;
      this.next = now;
    }
    if (fps && now + 0.5 < this.next) return null;
    const elapsed = this.previous === undefined ? 0 : Math.min((now - this.previous) / 1000, 0.1);
    this.previous = now;
    if (fps) {
      const interval = 1000 / fps;
      this.next += Math.max(1, Math.floor((now + 0.5 - this.next) / interval) + 1) * interval;
    } else this.next = now;
    return elapsed;
  }
}
