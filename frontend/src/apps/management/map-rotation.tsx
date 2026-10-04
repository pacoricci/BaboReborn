import { createSignal, For, Index, onCleanup, onMount, Show } from 'solid-js';
import { currentContent, loadMap } from '../../content/runtime';
import { themeByID } from '../../content/types';
import type { ManagedRoomDirectory } from '../../contracts/server';

// Draw the actual arena geometry, using the same orientation and colors as the editor.
function MapPreview(props: { id: string }) {
  let canvas!: HTMLCanvasElement;
  const [status, setStatus] = createSignal('Loading preview…');
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  onMount(() => {
    const info = currentContent().maps.find((map) => map.id === props.id);
    if (!info) {
      setStatus('Preview unavailable');
      return;
    }
    void loadMap(info)
      .then((map) => {
        if (disposed) return;
        const context = canvas.getContext('2d');
        if (!context) {
          setStatus('Preview unavailable');
          return;
        }
        const theme = themeByID(currentContent(), map.theme);
        const scale = Math.min(288 / map.width, 168 / map.height);
        const x = (320 - map.width * scale) / 2;
        const y = (200 - map.height * scale) / 2;
        context.fillStyle = theme.planFloor;
        context.fillRect(x, y, map.width * scale, map.height * scale);
        for (const wall of map.walls) {
          const material = theme.materials[wall.material ?? theme.defaultMaterial]!;
          context.fillStyle = `hsl(${material.wallHue} 15% ${Math.min(69, 27 + (wall.height ?? 0.7) * 7)}%)`;
          context.fillRect(
            x + wall.x * scale,
            y + (map.height - wall.y - wall.h) * scale,
            wall.w * scale,
            wall.h * scale,
          );
        }
        if (map.teams) {
          for (const [team, color] of [
            [map.teams.blue, '#62baff'],
            [map.teams.red, '#ff775c'],
          ] as const) {
            context.fillStyle = color;
            context.beginPath();
            context.arc(
              x + team.base.x * scale,
              y + (map.height - team.base.y) * scale,
              4,
              0,
              Math.PI * 2,
            );
            context.fill();
          }
        }
        setStatus('');
      })
      .catch(() => {
        if (!disposed) setStatus('Preview unavailable');
      });
  });
  return (
    <div class="map-preview" aria-hidden="true">
      <canvas
        ref={(element) => {
          canvas = element;
        }}
        width="320"
        height="200"
      />
      <Show when={status()}>
        <span>{status()}</span>
      </Show>
    </div>
  );
}

export function MapRotation(props: {
  maps: ManagedRoomDirectory['maps'];
  rotation: string[];
  mode: string;
  disabled: boolean;
  change(rotation: string[]): void;
}) {
  const [panel, setPanel] = createSignal('catalog');
  const [dragging, setDragging] = createSignal<number | null>(null);
  const [announcement, setAnnouncement] = createSignal('');
  const name = (id: string) => props.maps.find((map) => map.id === id)?.name ?? id;
  function move(from: number, to: number) {
    if (
      props.disabled ||
      from === to ||
      from < 0 ||
      to < 0 ||
      from >= props.rotation.length ||
      to >= props.rotation.length
    )
      return;
    const rotation = [...props.rotation];
    const [id] = rotation.splice(from, 1);
    rotation.splice(to, 0, id!);
    props.change(rotation);
    setAnnouncement(`${name(id!)} moved to position ${to + 1}.`);
    queueMicrotask(() => document.getElementById(`rotation-position-${to}`)?.focus());
  }
  return (
    <fieldset disabled={props.disabled} class="map-picker">
      <nav class="map-picker-tabs" aria-label="Map selection views">
        <button
          type="button"
          aria-pressed={panel() === 'catalog'}
          onClick={() => setPanel('catalog')}
        >
          Maps
        </button>
        <button
          type="button"
          aria-pressed={panel() === 'rotation'}
          onClick={() => setPanel('rotation')}
        >
          Rotation ({props.rotation.length}/16)
        </button>
      </nav>
      <div class="map-picker-layout" data-panel={panel()}>
        <section class="map-catalog" aria-label="Map catalog">
          <h3>Maps</h3>
          <p class="muted">Select a map to add it to the rotation.</p>
          <div class="map-cards">
            <For each={props.maps.filter((map) => props.mode !== 'ctf' || map.ctf)}>
              {(map) => {
                const positions = () =>
                  props.rotation.flatMap((id, index) => (id === map.id ? [index + 1] : []));
                return (
                  <button
                    type="button"
                    class="map-card"
                    classList={{ selected: positions().length > 0 }}
                    aria-label={`Add ${map.name}`}
                    disabled={props.rotation.length >= 16}
                    onClick={() => {
                      if (props.disabled || props.rotation.length >= 16) return;
                      props.change([...props.rotation, map.id]);
                      setAnnouncement(`${map.name} added at position ${props.rotation.length}.`);
                    }}
                  >
                    <MapPreview id={map.id} />
                    <span class="map-card-caption">
                      <strong>{map.name}</strong>
                      <span>{positions().join(', ') || '+'}</span>
                    </span>
                  </button>
                );
              }}
            </For>
          </div>
        </section>
        <section class="rotation-editor" aria-label="Selected rotation">
          <h3>
            Rotation <small>{props.rotation.length}/16</small>
          </h3>
          <p class="muted">Drag to reorder, or use the arrow buttons.</p>
          <Show when={props.rotation.length >= 16}>
            <p class="notice">Rotation full. Remove a map to add another.</p>
          </Show>
          <Show when={!props.rotation.length}>
            <p class="empty-state">Choose at least one map.</p>
          </Show>
          <ol>
            <Index each={props.rotation}>
              {(id, index) => (
                <li
                  classList={{ 'is-dragging': dragging() === index }}
                  onDragOver={(event) => {
                    if (dragging() !== null && !props.disabled) event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const from = dragging();
                    setDragging(null);
                    if (from !== null) move(from, index);
                  }}
                >
                  <button
                    type="button"
                    class="rotation-position"
                    id={`rotation-position-${index}`}
                    draggable={!props.disabled}
                    aria-label={`${name(id())}, position ${index + 1}. Use Alt and arrow keys to reorder.`}
                    onDragStart={(event) => {
                      setDragging(index);
                      if (event.dataTransfer) {
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', String(index));
                      }
                    }}
                    onDragEnd={() => setDragging(null)}
                    onKeyDown={(event) => {
                      if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                        event.preventDefault();
                        move(index, index + (event.key === 'ArrowUp' ? -1 : 1));
                      }
                    }}
                  >
                    {name(id())}
                  </button>
                  <Show
                    when={
                      !props.maps.some(
                        (map) => map.id === id() && (props.mode !== 'ctf' || map.ctf),
                      )
                    }
                  >
                    <small class="error">Not compatible with this mode</small>
                  </Show>
                  <div class="inline-actions">
                    <button
                      type="button"
                      disabled={index === 0}
                      aria-label={`Move ${name(id())} up`}
                      onClick={() => move(index, index - 1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={index === props.rotation.length - 1}
                      aria-label={`Move ${name(id())} down`}
                      onClick={() => move(index, index + 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${name(id())}`}
                      onClick={() => {
                        props.change(props.rotation.filter((_, i) => i !== index));
                        setAnnouncement('Map removed.');
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              )}
            </Index>
          </ol>
        </section>
      </div>
      <p class="visually-hidden" role="status">
        {announcement()}
      </p>
    </fieldset>
  );
}
