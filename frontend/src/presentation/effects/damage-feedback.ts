import { PLAYER } from '../../gameconfig/tuning';
// Source-derived screen-hit envelope normalized by configured maximum health.
// Player::hit accumulates damage, Player::update fades 0.25/s, and ClientRender
// multiplies the result by three. The overlay itself has no attacker direction.
export class DamageFeedback {
  private intensity = 0;
  private updatedAt = 0;

  private advance(now: number): void {
    this.intensity = Math.max(0, this.intensity - Math.max(0, now - this.updatedAt) / 4000);
    this.updatedAt = now;
  }

  hit(damage: number, now: number): void {
    this.advance(now);
    this.intensity = Math.min(1, this.intensity + Math.max(0, damage) / PLAYER.maxHealth);
  }

  opacity(now: number): number {
    this.advance(now);
    return Math.min(1, this.intensity * 3);
  }

  reset(): void {
    this.intensity = 0;
  }
}
