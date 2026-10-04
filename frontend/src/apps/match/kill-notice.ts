import type { Activity } from '../../contracts/activity';

const DISPLAY_MS = 1500;
const MULTIKILL_WINDOW_MS = 3000;
const FADE_MS = 250;

// Receives only fresh, deduplicated activities from the session's required events.
export class KillNotice {
  private count = 0;
  private lastKillAt = -Infinity;
  private expires = 0;
  private victim = '';
  private victimColors: string | undefined;
  private revision = 0;

  reset(): void {
    this.count = 0;
    this.lastKillAt = -Infinity;
    this.expires = 0;
    this.victim = '';
    this.victimColors = undefined;
  }

  receive(event: Activity, ownID: number, now: number): void {
    if (event.kind !== 'kill' || event.actor.id !== ownID || event.victim.id === ownID) return;
    this.revision++;
    const gap = event.occurredAtMs - this.lastKillAt;
    this.count = gap >= 0 && gap <= MULTIKILL_WINDOW_MS ? this.count + 1 : 1;
    // Count the server's spacing, so a delayed batch cannot manufacture a multikill.
    this.lastKillAt = event.occurredAtMs;
    this.victim = event.victim.nickname;
    this.victimColors = event.victim.nicknameColors;
    this.expires = now + DISPLAY_MS;
  }

  visible(now: number) {
    if (now >= this.expires) return null;
    return {
      revision: this.revision,
      count: this.count,
      label:
        this.count === 1
          ? 'Eliminated'
          : this.count === 2
            ? 'Double kill'
            : this.count === 3
              ? 'Triple kill'
              : `${this.count} kills`,
      victim: this.victim,
      ...(this.victimColors ? { victimColors: this.victimColors } : {}),
      opacity: Math.min(1, (this.expires - now) / FADE_MS),
    };
  }
}
