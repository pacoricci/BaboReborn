// Stream the long track instead of decoding it into the combat sample bank.
export class MatchMusic {
  private readonly track = new Audio('/audio/music.ogg');
  private started = false;
  private enabled = true;

  constructor() {
    this.track.loop = true;
    this.track.preload = 'none';
    this.track.volume = 0;
  }

  configure(enabled: boolean, volume: number): void {
    this.enabled = enabled;
    this.track.volume = Math.max(0, Math.min(1, volume));
    this.sync();
  }

  start(): void {
    this.started = true;
    this.sync();
  }

  sync(): void {
    if (!this.started || !this.enabled || document.hidden || this.track.volume === 0) {
      this.track.pause();
      return;
    }
    // Autoplay or network failures must not interrupt play; the next gesture retries.
    void this.track.play().catch(() => {});
  }

  stop(): void {
    this.started = false;
    this.track.pause();
  }

  dispose(): void {
    this.stop();
    this.track.removeAttribute('src');
    this.track.load();
  }
}
