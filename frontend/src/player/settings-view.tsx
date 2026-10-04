import { createSignal, For, Show, onCleanup } from 'solid-js';
import {
  actionLabels,
  bindingLabel,
  defaultBindings,
  defaultOptions,
  validBinding,
} from './game-options';
import type { Action } from './game-options';
import type { PlayerSettings } from './player-preferences';
import './settings.css';

export function SettingsPanel(props: {
  settings: PlayerSettings;
  change(patch: Partial<PlayerSettings>): void;
}) {
  let ignoreClick = false;
  const [fullscreen, setFullscreen] = createSignal(!!document.fullscreenElement);
  const [fullscreenError, setFullscreenError] = createSignal('');
  const updateFullscreen = () => setFullscreen(!!document.fullscreenElement);
  document.addEventListener('fullscreenchange', updateFullscreen);
  onCleanup(() => document.removeEventListener('fullscreenchange', updateFullscreen));
  async function toggleFullscreen() {
    try {
      setFullscreenError('');
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setFullscreenError('Full screen unavailable. Try again.');
    }
  }
  const [capture, setCapture] = createSignal<Action>();
  const [notice, setNotice] = createSignal('');
  function bind(code: string) {
    const action = capture();
    if (!action) return;
    if (!validBinding(code)) {
      setNotice(
        'Reserved or unsupported key. Choose a letter, number, Space, Tab or mouse button.',
      );
      return;
    }
    const conflict = (Object.keys(actionLabels) as Action[]).find(
      (key) => key !== action && props.settings.bindings[key] === code,
    );
    if (conflict) {
      setNotice(`Already assigned to ${actionLabels[conflict].toLowerCase()}.`);
      return;
    }
    props.change({ bindings: { ...props.settings.bindings, [action]: code } });
    setCapture(undefined);
    setNotice('');
  }
  return (
    <div class="game-settings">
      <fieldset>
        <legend>Audio</legend>
        <label>
          <span>Combat sounds</span>
          <input
            id="sound-enabled"
            type="checkbox"
            checked={props.settings.sound}
            onChange={(e) => props.change({ sound: e.currentTarget.checked })}
          />
        </label>
        <label>
          <span>Combat volume · {props.settings.volume}%</span>
          <input
            aria-label="Combat volume"
            type="range"
            min="0"
            max="100"
            value={props.settings.volume}
            onInput={(e) => props.change({ volume: +e.currentTarget.value })}
          />
        </label>
        <label>
          <span>Music</span>
          <input
            type="checkbox"
            checked={props.settings.music}
            onChange={(e) => props.change({ music: e.currentTarget.checked })}
          />
        </label>
        <label>
          <span>Music volume · {props.settings.musicVolume}%</span>
          <input
            aria-label="Music volume"
            type="range"
            min="0"
            max="100"
            value={props.settings.musicVolume}
            onInput={(e) => props.change({ musicVolume: +e.currentTarget.value })}
          />
        </label>
        <p class="muted">Audio is muted while the browser tab is hidden.</p>
        <button
          type="button"
          class="text-action"
          onClick={() =>
            props.change({
              sound: true,
              volume: defaultOptions.volume,
              music: true,
              musicVolume: defaultOptions.musicVolume,
            })
          }
        >
          Reset audio
        </button>
      </fieldset>
      <fieldset>
        <legend>Controls</legend>
        <p class="muted">
          Select an action, then press a key or mouse button. Esc cancels. Arrow keys also move. Esc
          / M, H, G and L / F8 remain menu, help, full screen and diagnostics shortcuts.
        </p>
        <div class="binding-list">
          <For each={Object.keys(actionLabels) as Action[]}>
            {(action) => (
              <div>
                <span>{actionLabels[action]}</span>
                <button
                  type="button"
                  aria-label={`Bind ${actionLabels[action]}`}
                  aria-pressed={capture() === action}
                  onClick={() => {
                    if (ignoreClick) {
                      ignoreClick = false;
                      return;
                    }
                    setCapture(action);
                    setNotice('');
                  }}
                  onKeyDown={(e) => {
                    if (!capture()) return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.code === 'Escape') {
                      setCapture(undefined);
                      setNotice('');
                    } else if (!e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) bind(e.code);
                  }}
                  onPointerDown={(e) => {
                    if (capture() === action) {
                      e.preventDefault();
                      e.stopPropagation();
                      ignoreClick = e.button === 0;
                      bind(`Mouse${e.button}`);
                    }
                  }}
                  onBlur={() => {
                    setCapture(undefined);
                    setNotice('');
                  }}
                  onContextMenu={(e) => e.preventDefault()}
                >
                  {capture() === action
                    ? 'Press a key…'
                    : bindingLabel(props.settings.bindings[action])}
                </button>
              </div>
            )}
          </For>
        </div>
        <p role="status">{notice()}</p>
        <button
          type="button"
          class="text-action"
          onClick={() => {
            setCapture(undefined);
            setNotice('');
            props.change({ bindings: { ...defaultBindings } });
          }}
        >
          Reset controls
        </button>
      </fieldset>
      <fieldset>
        <legend>Graphics</legend>
        <Show when={document.fullscreenEnabled}>
          <button type="button" onClick={() => void toggleFullscreen()}>
            {fullscreen() ? 'Exit full screen' : 'Full screen'}
          </button>
          <p role="status">{fullscreenError()}</p>
        </Show>
        <label>
          <span>Quality</span>
          <select
            value={props.settings.quality}
            onChange={(e) =>
              props.change({ quality: e.currentTarget.value as PlayerSettings['quality'] })
            }
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>
        <p class="muted">
          {props.settings.quality === 'low'
            ? 'Half resolution, no shadows.'
            : props.settings.quality === 'medium'
              ? 'Three-quarter resolution, shadows enabled.'
              : 'Full resolution, shadows enabled.'}
        </p>
        <label>
          <span>Frame limit</span>
          <select
            value={props.settings.fps}
            onChange={(e) => props.change({ fps: +e.currentTarget.value })}
          >
            <For each={[0, 30, 60, 120, 144]}>
              {(fps) => <option value={fps}>{fps ? `${fps} FPS` : 'Display refresh rate'}</option>}
            </For>
          </select>
        </label>
        <button
          type="button"
          class="text-action"
          onClick={() => props.change({ quality: defaultOptions.quality, fps: defaultOptions.fps })}
        >
          Reset graphics
        </button>
      </fieldset>
      <fieldset>
        <legend>Readability</legend>
        <label>
          <span>Crosshair size · {props.settings.crosshairSize}px</span>
          <input
            aria-label="Crosshair size"
            type="range"
            min="10"
            max="36"
            value={props.settings.crosshairSize}
            onInput={(e) => props.change({ crosshairSize: +e.currentTarget.value })}
          />
        </label>
        <label>
          <span>Crosshair color</span>
          <input
            aria-label="Crosshair color"
            type="color"
            value={props.settings.crosshairColor}
            onInput={(e) => props.change({ crosshairColor: e.currentTarget.value })}
          />
        </label>
        <div class="crosshair-preview" aria-label="Crosshair preview">
          <span
            style={{
              width: `${props.settings.crosshairSize}px`,
              height: `${props.settings.crosshairSize}px`,
              'border-color': props.settings.crosshairColor,
            }}
          />
        </div>
        <label>
          <span>Reduce visual effects</span>
          <input
            type="checkbox"
            checked={props.settings.reducedEffects}
            onChange={(e) => props.change({ reducedEffects: e.currentTarget.checked })}
          />
        </label>
        <p class="muted">
          Reduces damage flashes and removes blood. Weapon and danger indicators remain visible.
        </p>
        <button
          type="button"
          class="text-action"
          onClick={() =>
            props.change({
              crosshairSize: defaultOptions.crosshairSize,
              crosshairColor: defaultOptions.crosshairColor,
              reducedEffects: false,
            })
          }
        >
          Reset readability
        </button>
      </fieldset>
      <details>
        <summary>Diagnostics</summary>
        <label>
          <span>Collect diagnostics</span>
          <input
            type="checkbox"
            checked={props.settings.collectDiagnostics}
            onChange={(e) => props.change({ collectDiagnostics: e.currentTarget.checked })}
          />
        </label>
        <Show when={props.settings.collectDiagnostics}>
          <p class="muted">In a match, press L or F8 to export collected data.</p>
        </Show>
      </details>
    </div>
  );
}
