import type { ArenaView } from '../../presentation/view';
import type { Vec2 } from '../../core/geometry';

export function updateSniperScope(
  overlay: HTMLElement,
  view: ArenaView,
  active: boolean,
  height: number,
  pointer: Vec2,
): void {
  // Original scope: peripheral vision fades from camera height 10 to 12.
  const opacity =
    active && view.player.visible !== false && view.player.primary === 'sniper'
      ? Math.max(0, Math.min(1, (height - 10) / 2))
      : 0;
  overlay.hidden = opacity === 0;
  if (overlay.hidden) return;
  overlay.style.opacity = String(opacity);
  overlay.style.setProperty('--scope-x', `${pointer.x}px`);
  overlay.style.setProperty('--scope-y', `${pointer.y}px`);
}
