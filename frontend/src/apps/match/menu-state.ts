import type { Match, LocalPlayer } from '../../contracts/session';

// Presentation permissions come from authority, never from which panel is open.
export function matchMenuState(
  own: LocalPlayer,
  match: Match,
  tick: number,
  tickHz: number,
  joining = false,
  fire = 'Left mouse',
) {
  const remaining = Math.max(0, (own.diedTick + match.rules.respawnTicks - tick) / tickHz);
  const intermission = match.phase === 'intermission';
  const spectator = own.status === 'spectator';
  const alive = own.status === 'alive';
  const canRespawn = !intermission && own.status === 'dead' && remaining === 0;
  const lifeNotice = alive
    ? 'You can still take damage while this menu is open.'
    : spectator
      ? 'Choose Play to join.'
      : remaining > 0
        ? `Respawn in ${Math.ceil(remaining)}s.`
        : match.rules.forceRespawn
          ? 'You will respawn automatically.'
          : `Ready to respawn. Return to the arena, then press ${fire} to spawn.`;
  return {
    canJoin: spectator && !intermission && !joining,
    canRespawn: canRespawn && !match.rules.forceRespawn,
    spectator,
    intermission,
    remaining,
    status: intermission
      ? 'Round complete'
      : joining
        ? 'Joining…'
        : spectator
          ? 'Spectating'
          : alive
            ? 'Alive'
            : remaining > 0
              ? 'Eliminated'
              : 'Ready to respawn',
    title: intermission
      ? 'Round complete'
      : spectator
        ? 'Join the match'
        : alive
          ? 'Match menu'
          : remaining > 0
            ? 'You were eliminated'
            : 'Ready to respawn',
    notice: intermission
      ? `Next match in ${Math.max(0, Math.ceil((match.endsTick - tick) / tickHz))}s.`
      : joining
        ? 'Joining…'
        : lifeNotice,
    returnLabel: spectator ? 'Watch match' : alive ? 'Resume match' : 'Back to arena',
  };
}
