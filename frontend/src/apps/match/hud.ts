import { paintNickname } from '../../ui/nickname';
import { activityRow } from './activity-feed-view';
import { primaryReloadProgress } from './primary-reload';
import { PLAYER, SHOTGUN, PICKUPS } from '../../gameconfig/tuning';
import type { OnlineSession } from './session';
let feedKey = '';
let feedSession: OnlineSession | null = null;
const el = (id: string) => document.getElementById(id)!;

export function updateHud(session: OnlineSession, now: number, hitUntil: number): number {
  const { prediction, latest } = session;
  const feed = el('activity-feed');
  // Keep recent activity readable without letting the feed cover the arena.
  const rows = session.activityFeed.visible(now).slice(-3);
  const key = rows.map((row) => row.event.id).join(',');
  if (feedSession !== session || key !== feedKey) {
    feedSession = session;
    feedKey = key;
    feed.replaceChildren(...rows.map(({ event }) => activityRow(event)));
  }
  rows.forEach((row, index) => {
    (feed.children[index] as HTMLElement).style.opacity = String(
      Math.min(1, (row.expiresAtMs - now) / 1000),
    );
  });
  const notice = session.killNotice.visible(now);
  const notification = el('kill-notice');
  notification.hidden = notice === null;
  if (notice) {
    const revision = String(notice.revision);
    notification.classList.toggle('multikill', notice.count > 1);
    if (notification.dataset.revision !== revision) {
      notification.dataset.revision = revision;
      // Restart even when consecutive kills have the same label and victim.
      for (const animation of notification.getAnimations()) animation.cancel();
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        notification.animate(
          [
            { transform: 'translateX(-50%) translateY(8px) scale(1.18)', opacity: 0 },
            {
              transform: 'translateX(-50%) translateY(-2px) scale(1.03)',
              opacity: 1,
              offset: 0.35,
            },
            { transform: 'translateX(-50%) translateY(0) scale(1)', opacity: 1 },
          ],
          { duration: 320, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
        );
      }
    }
    const label = el('kill-notice-label');
    const victim = el('kill-notice-victim');
    if (label.textContent !== notice.label) label.textContent = notice.label;
    paintNickname(victim, notice.victim, notice.victimColors);
    notification.style.opacity = String(notice.opacity);
  } else {
    delete notification.dataset.revision;
  }
  el('crosshair').classList.toggle('hit', now < hitUntil);
  const match = latest?.match;
  const own = prediction.own;
  const player = prediction.player;
  const reload = primaryReloadProgress(
    player,
    own?.status === 'alive' && match?.phase !== 'intermission',
  );
  el('primary-reload').hidden = reload === null;
  if (reload !== null) {
    el('primary-reload-fill').style.transform = `scaleX(${reload})`;
    el('primary-reload').setAttribute('aria-valuenow', String(Math.round(reload * 100)));
  }
  const showVitals = !!own && own.status !== 'spectator' && match?.phase !== 'intermission';
  el('player-vitals').hidden = !showVitals;
  if (showVitals) {
    const hp = Math.max(0, Math.min(PLAYER.maxHealth, own.hp));
    el('health').textContent = `${Math.ceil(hp)} HP`;
    el('health-meter').setAttribute('aria-valuenow', String(hp));
    el('health-meter').setAttribute('aria-valuemax', String(PLAYER.maxHealth));
    el('health-fill').style.transform = `scaleY(${hp / PLAYER.maxHealth})`;
    // Hue follows remaining health: red at zero, yellow halfway, green at full health.
    el('health-fill').style.backgroundColor = `hsl(${120 * (hp / PLAYER.maxHealth)} 80% 45%)`;
  }
  el('ammo').hidden = !showVitals || own?.status !== 'alive' || !player;
  if (showVitals && player) {
    const equipment = player.equipment;
    // Primary ammo only matters for the shotgun; throwables always expose their stock.
    el('ammo-primary').hidden = equipment.primary !== 'shotgun';
    for (const [kind, count] of [
      ['primary', Math.max(0, SHOTGUN.shells - equipment.shells)],
      ['grenade', equipment.grenades],
      ['molotov', equipment.molotovs],
    ] as const) {
      const counter = el(`ammo-${kind}-count`);
      counter.textContent = String(count);
      counter.parentElement!.toggleAttribute('data-empty', count === 0);
    }
  }
  const flags = el('flag-status');
  flags.hidden = match?.rules.mode !== 'ctf';
  if (match?.rules.mode === 'ctf') {
    for (const team of ['red', 'blue'] as const) {
      el(`${team}-score`).textContent = match.rules.scoreLimit
        ? `${match.scores[team]}/${match.rules.scoreLimit}`
        : String(match.scores[team]);
    }
  }
  if (match && latest) {
    const seconds = Math.ceil(
      (match.phase === 'intermission'
        ? match.endsTick - latest.tick
        : Math.max(0, match.rules.timeLimitTicks - (latest.tick - match.startedTick))) /
        session.welcome.tickHz,
    );
    el('match-clock').textContent =
      match.phase === 'intermission'
        ? `Next match in ${seconds}s`
        : match.rules.timeLimitTicks
          ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
          : 'No time limit';
  } else {
    el('match-clock').textContent = '';
  }

  const nearest = latest?.items
    .filter(
      (i) =>
        i.kind === 'weapon' &&
        Math.hypot(i.position.x - prediction.player!.x, i.position.y - prediction.player!.y) <=
          PICKUPS.radius,
    )
    .sort((a, b) => a.id - b.id)[0];

  // Pickup selection remains active without a HUD hint.
  return nearest?.id ?? 0;
}
