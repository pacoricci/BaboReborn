// Canvas-only projection of the arena view; no Babylon scene or simulation lifecycle.
import { CAMERA } from '../camera';
import type { ArenaMap } from '../../maps/types';
import type { ArenaView } from '../view';

export function drawMinimap(
  ctx: CanvasRenderingContext2D,
  arena: ArenaMap,
  view: ArenaView,
  camera: { x: number; y: number; height: number; fov: number },
): void {
  const scale = 216 / Math.max(arena.width, arena.height);
  ctx.fillStyle = '#273a2e';
  ctx.fillRect(0, 0, 216, 216);
  ctx.fillStyle = '#728362';
  for (const wall of arena.walls)
    ctx.fillRect(
      wall.x * scale,
      (arena.height - wall.y - wall.h) * scale,
      wall.w * scale,
      wall.h * scale,
    );
  for (const target of view.actors) {
    const opacity = target.minimapOpacity ?? (target.visible ? 1 : 0);
    if (opacity <= 0) continue;
    ctx.globalAlpha = opacity;
    ctx.fillStyle = target.minimapColor ?? target.marker ?? '#efa778';
    ctx.beginPath();
    ctx.arc(target.x * scale, (arena.height - target.y) * scale, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  for (const object of view.objects ?? []) {
    if (!object.kind.startsWith('flag-') && !object.kind.startsWith('base-')) continue;
    ctx.fillStyle = object.kind.endsWith('blue') ? '#55aaff' : '#ff665e';
    const x = object.x * scale,
      y = (arena.height - object.y) * scale;
    if (object.kind.startsWith('flag-')) {
      ctx.fillRect(x - 3, y - 5, 6, 6);
    } else {
      ctx.strokeStyle = ctx.fillStyle;
      ctx.strokeRect(x - 5, y - 5, 10, 10);
    }
  }
  const p = view.player;
  ctx.strokeStyle = '#8fcfe866';
  ctx.lineWidth = 1;
  const h = camera.height * Math.tan(camera.fov / 2) * 2,
    w = h * CAMERA.aspect;
  ctx.strokeRect(
    (camera.x - w / 2) * scale,
    (arena.height - camera.y - h / 2) * scale,
    w * scale,
    h * scale,
  );
  if (p.visible === false) return;
  ctx.fillStyle = p.minimapColor ?? p.marker ?? '#9fe4fa';
  ctx.beginPath();
  ctx.arc(p.x * scale, (arena.height - p.y) * scale, 3.5, 0, Math.PI * 2);
  ctx.fill();
}
