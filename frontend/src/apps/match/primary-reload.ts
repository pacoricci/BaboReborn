import type { Player } from '../../core/simulation';
import { BAZOOKA, PHOTON, SHOTGUN, SNIPER } from '../../gameconfig/tuning';

/** Read predicted cooldown directly so reconciliation and weapon swaps cannot leave stale timers. */
export function primaryReloadProgress(
  player: Readonly<Player> | null,
  active: boolean,
): number | null {
  if (!active || !player || player.cooldown <= 1e-9) return null;
  let duration: number;
  switch (player.equipment.primary) {
    case 'shotgun':
      // The short delay between shells is not a magazine reload.
      if (player.equipment.shells !== SHOTGUN.shells) return null;
      duration = SHOTGUN.reloadSeconds;
      break;
    case 'sniper':
      duration = SNIPER.fireIntervalSeconds;
      break;
    case 'bazooka':
      duration = BAZOOKA.fireIntervalSeconds;
      break;
    case 'photon':
      duration = PHOTON.fireIntervalSeconds;
      break;
    default:
      return null;
  }
  return Math.max(0, Math.min(1, 1 - player.cooldown / duration));
}
