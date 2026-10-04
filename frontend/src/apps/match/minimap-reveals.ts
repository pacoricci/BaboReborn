import type { GameCue, GameEvent, RemotePlayer, Snapshot } from '../../contracts/session';

const REVEAL_MS = 2000;
const ALLY_FLASH_CHANNEL = 0.7;
const MINIMAP_COLORS = {
  self: { blue: '#00ffff', red: '#ffff00' },
  enemy: { blue: '#4d4dff', red: '#ff0000' },
} as const;

export function localMinimapColor(team: RemotePlayer['team'] | undefined): string {
  // DM has no teams: retain cyan for self and red for opponents.
  return MINIMAP_COLORS.self[team === 'red' ? 'red' : 'blue'];
}

// Presentation only: hiding a marker does not remove network-visible coordinates.
export class MinimapReveals {
  private readonly reveals = new Map<number, { life: number; until: number }>();
  private round = 0;

  snapshot(state: Snapshot, now: number, authorityNow: number, tickHz: number): void {
    if (state.match.round !== this.round) this.reveals.clear();
    this.round = state.match.round;
    for (const [id, reveal] of this.reveals) {
      const player = state.players.find((p) => p.id === id);
      if (!player || player.life !== reveal.life || reveal.until <= now) this.reveals.delete(id);
    }
    for (const projectile of state.projectiles) {
      if (projectile.kind === 'flame') continue; // Lingering fire is not a new attack.
      const player = state.players.find((p) => p.id === projectile.ownerId);
      if (!player || projectile.bornTick < player.bornTick) continue;
      const age =
        Math.max(0, authorityNow - state.capturedAtMs) +
        ((state.tick - projectile.bornTick) * 1000) / tickHz;
      this.reveal(player, now, age);
    }
  }

  event(event: GameCue | GameEvent, state: Snapshot, now: number, authorityNow: number): void {
    const attack =
      (event.kind === 'shot' && event.shot.kind !== 'minibot') ||
      event.kind === 'knives' ||
      (event.kind === 'signal' && event.signal === 'throw');
    if (!attack || event.round !== state.match.round) return;
    const player = state.players.find((p) => p.id === event.ownerId && p.life === event.life);
    if (player) this.reveal(player, now, Math.max(0, authorityNow - event.occurredAtMs));
  }

  opacity(
    player: RemotePlayer,
    own: RemotePlayer | null | undefined,
    state: Snapshot,
    now: number,
  ): number {
    if (own?.status === 'spectator') return player.status === 'alive' ? 1 : 0;
    if (state.match.rules.mode !== 'dm' && own?.team === player.team && player.team !== 'none')
      return player.status === 'alive' ? 1 : 0;
    return this.strength(player, now);
  }

  color(
    player: RemotePlayer,
    own: RemotePlayer | null | undefined,
    state: Snapshot,
    now: number,
  ): string {
    const team = player.team === 'blue' ? 'blue' : 'red';
    const allied =
      own?.status === 'spectator' ||
      (state.match.rules.mode !== 'dm' && own?.team === player.team && player.team !== 'none');
    if (!allied) return MINIMAP_COLORS.enemy[team];
    const channel = Math.round(255 * ALLY_FLASH_CHANNEL * this.strength(player, now));
    return team === 'blue'
      ? `rgb(${channel}, ${channel}, 255)`
      : `rgb(255, ${channel}, ${channel})`;
  }

  private strength(player: RemotePlayer, now: number): number {
    const reveal = this.reveals.get(player.id);
    return reveal?.life === player.life
      ? Math.max(0, Math.min(1, (reveal.until - now) / REVEAL_MS))
      : 0;
  }

  private reveal(player: RemotePlayer, now: number, age: number): void {
    if (age >= REVEAL_MS) return;
    const until = now + REVEAL_MS - age;
    const previous = this.reveals.get(player.id);
    if (!previous || previous.life !== player.life || until > previous.until)
      this.reveals.set(player.id, { life: player.life, until });
  }
}
