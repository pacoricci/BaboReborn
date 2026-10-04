import { createResource, createEffect, Show } from 'solid-js';
import { currentContent, loadMap } from '../../content/runtime';
import { Dialog } from '../../ui/dialog';
import { MODE_OBJECTIVES } from './catalog';
import { MODE_NAMES } from '../../contracts/mode';
import type { CatalogRoom } from './catalog';

export function RoomDetails(props: { room: CatalogRoom; close(): void; enter(): void }) {
  let canvas!: HTMLCanvasElement;
  const [arena] = createResource(
    () => props.room.details.mapId,
    async (id) => {
      const info = currentContent().maps.find((map) => map.id === id);
      return info ? loadMap(info) : undefined;
    },
  );
  createEffect(() => {
    if (arena.error) return;
    const map = arena();
    const ctx = canvas?.getContext('2d');
    if (!map || !ctx) return;
    const scale = Math.min(canvas.width / map.width, canvas.height / map.height);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate((canvas.width - map.width * scale) / 2, (canvas.height - map.height * scale) / 2);
    ctx.fillStyle = '#24292b';
    ctx.fillRect(0, 0, map.width * scale, map.height * scale);
    ctx.fillStyle = '#bebbb5';
    for (const wall of map.walls)
      ctx.fillRect(
        wall.x * scale,
        (map.height - wall.y - wall.h) * scale,
        wall.w * scale,
        wall.h * scale,
      );
    if (map.teams && props.room.mode !== 'dm')
      for (const [team, color] of [
        [map.teams.blue, '#55aaff'],
        [map.teams.red, '#ff665e'],
      ] as const) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(team.base.x * scale, (map.height - team.base.y) * scale, 6, 0, Math.PI * 2);
        ctx.fill();
      }
    ctx.restore();
  });
  return (
    <Dialog labelledBy="room-details-title" cancel={() => props.close()}>
      <div class="room-details">
        <header>
          <h2 id="room-details-title">{props.room.name}</h2>
          <button onClick={() => props.close()}>Close</button>
        </header>
        <p>
          {MODE_NAMES[props.room.mode]} · {props.room.map}
        </p>
        <p>{MODE_OBJECTIVES[props.room.mode]}</p>
        <canvas
          ref={(element) => {
            canvas = element;
          }}
          width="480"
          height="280"
          role="img"
          aria-label={`Overhead layout of ${props.room.map}`}
          hidden={!!arena.error || !arena()}
        />
        <Show when={arena.loading}>
          <p role="status">Loading map…</p>
        </Show>
        <Show when={!arena.loading && (!!arena.error || !arena())}>
          <p>Map preview unavailable.</p>
        </Show>
        <p>
          {props.room.details.players} players · {props.room.details.bots} bots ·{' '}
          {props.room.details.spectators} spectators
        </p>
        <p>
          {props.room.details.scoreLimit
            ? `${props.room.details.scoreLimit} ${props.room.mode === 'ctf' ? 'captures' : 'points'}`
            : 'No score limit'}{' '}
          ·{' '}
          {props.room.details.timeLimitSeconds
            ? `${props.room.details.timeLimitSeconds / 60} min`
            : 'No time limit'}
        </p>
        <Show when={props.room.mode !== 'dm'}>
          <p>Friendly fire off</p>
        </Show>
        <p>
          {props.room.occupied} / {props.room.capacity} slots · {props.room.serverName}
          {props.room.region ? ` · ${props.room.region}` : ''}
        </p>
        <button
          class="primary"
          disabled={props.room.occupied >= props.room.capacity}
          onClick={() => props.enter()}
        >
          {props.room.occupied >= props.room.capacity ? 'Room full' : 'Enter room'}
        </button>
      </div>
    </Dialog>
  );
}
