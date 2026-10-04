import { NicknameEditor } from './nickname-editor';
import { SettingsPanel } from './settings-view';
import { createEffect, createSignal, For, Show, onCleanup, onMount } from 'solid-js';
import { EQUIPMENT_NAMES, PRIMARIES, SECONDARIES } from '../core/equipment';
import type { PreferencesApplication } from './preferences';
import { skinPreview } from '../presentation/ui/skin-preview';
import '../presentation/ui/appearance-controls.css';
import './character.css';

export function Character(props: { app: PreferencesApplication }) {
  const state = props.app.state;
  const [editingNickname, setEditingNickname] = createSignal(false);
  const [previewState, setPreviewState] = createSignal({
    paused: false,
    ready: false,
    message: '',
  });
  let canvas!: HTMLCanvasElement;
  let preview: ReturnType<typeof skinPreview> | undefined;
  const selection = () => ({
    appearance: state.appearance,
    primary: state.settings.primary,
  });
  const updatePreview = () =>
    preview?.update(
      selection(),
      `${state.appearance.template} Babo with ${EQUIPMENT_NAMES[state.settings.primary]}`,
    );
  onMount(() => {
    preview = skinPreview(canvas, setPreviewState);
    updatePreview();
  });
  createEffect(updatePreview);
  onCleanup(() => preview?.dispose());
  function color(index: number, value: string) {
    const colors = [...state.appearance.colors] as [string, string, string];
    colors[index] = value;
    props.app.appearance({ ...state.appearance, colors });
  }
  return (
    <>
      <p class="preference-feedback" role="status" aria-atomic="true">
        {state.characterFeedback}
      </p>
      <div class="profile-layout">
        <div class="profile-settings">
          <div class="profile-nickname">
            <label for="nickname">Nickname</label>
            <input
              id="nickname"
              maxlength="20"
              value={state.settings.nickname}
              onChange={(event) => {
                const input = event.currentTarget;
                input.setCustomValidity(props.app.nickname(input.value));
                if (input.reportValidity()) input.value = state.settings.nickname;
              }}
              onInput={(event) => event.currentTarget.setCustomValidity('')}
            />
            <button
              id="edit-nickname"
              class="nickname-advanced"
              type="button"
              onClick={() => setEditingNickname(true)}
            >
              Advanced…
            </button>
            <Show when={editingNickname()}>
              <NicknameEditor app={props.app} close={() => setEditingNickname(false)} />
            </Show>
          </div>
          <section id="appearance" aria-labelledby="appearance-heading">
            <h2 id="appearance-heading">Appearance</h2>
            <div class="appearance-controls">
              <label>
                Skin
                <select
                  aria-label="Skin"
                  value={state.appearance.template}
                  onChange={(event) =>
                    props.app.appearance({
                      ...state.appearance,
                      template: event.currentTarget.value,
                    })
                  }
                >
                  <For each={props.app.catalog.skins}>
                    {(skin) => <option value={skin.id}>{skin.name}</option>}
                  </For>
                </select>
              </label>
              <For each={[0, 1, 2]}>
                {(index) => (
                  <label>
                    Color {index + 1}
                    <input
                      type="color"
                      aria-label={`Skin color ${index + 1}`}
                      value={state.appearance.colors[index]}
                      onChange={(event) => color(index, event.currentTarget.value)}
                    />
                  </label>
                )}
              </For>
            </div>
            <p role="status" hidden={!state.unavailableSkin}>
              Your previous skin is unavailable. Choose another skin.
            </p>
          </section>
          <section class="profile-equipment" aria-labelledby="equipment-heading">
            <h2 id="equipment-heading">Equipment</h2>
            <div class="loadout">
              <label>
                Primary
                <select
                  id="primary"
                  value={state.settings.primary}
                  onChange={(event) => props.app.primary(event.currentTarget.value)}
                >
                  <For each={PRIMARIES}>
                    {(weapon) => <option value={weapon}>{EQUIPMENT_NAMES[weapon]}</option>}
                  </For>
                </select>
              </label>
              <label>
                Secondary
                <select
                  id="secondary"
                  value={state.settings.secondary}
                  onChange={(event) => props.app.secondary(event.currentTarget.value)}
                >
                  <For each={SECONDARIES}>
                    {(weapon) => <option value={weapon}>{EQUIPMENT_NAMES[weapon]}</option>}
                  </For>
                </select>
              </label>
            </div>
          </section>
        </div>
        <aside class="identity-card">
          <canvas
            ref={(element) => {
              canvas = element;
            }}
            id="skin-preview"
            width="480"
            height="400"
            role="img"
            tabindex="0"
            aria-describedby="preview-orbit-help"
            title="Drag to rotate. Double-click to reset."
          />
          <p id="preview-orbit-help" class="muted preview-orbit-help">
            Drag to rotate · Double-click to reset{' '}
            <span class="visually-hidden">Arrow keys rotate the view. Home resets the view.</span>
          </p>
          <div class="preview-equipment">
            <strong id="preview-primary">{EQUIPMENT_NAMES[state.settings.primary]}</strong>
          </div>
          <button
            id="preview-motion"
            type="button"
            aria-controls="skin-preview"
            aria-label={previewState().paused ? 'Play animation' : 'Pause animation'}
            title={previewState().paused ? 'Play animation' : 'Pause animation'}
            aria-pressed={previewState().paused}
            disabled={!previewState().ready}
            onClick={() => preview?.toggle()}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d={previewState().paused ? 'M8 5v14l11-7z' : 'M6 5h4v14H6zm8 0h4v14h-4z'}
                fill="currentColor"
              />
            </svg>
          </button>
          <p id="preview-status" class="muted" role="status">
            {previewState().message}
          </p>
        </aside>
      </div>
    </>
  );
}
export function Options(props: { app: PreferencesApplication; serverID?: string }) {
  const state = props.app.state;
  let development!: HTMLDivElement;
  let disposed = false;
  onMount(() => {
    if (import.meta.env.DEV)
      void import('./development-tools').then(({ installDevelopmentTools }) => {
        if (!disposed) installDevelopmentTools(development);
      });
  });
  onCleanup(() => {
    disposed = true;
  });
  return (
    <div class="options-page">
      <p id="options-saved" class="preference-feedback" role="status" aria-atomic="true">
        {state.optionsFeedback}
      </p>
      <SettingsPanel settings={state.settings} change={props.app.options} />
      <p>
        <a class="back-link" href="/editor.html">
          Map builder →
        </a>
      </p>
      <div
        ref={(element) => {
          development = element;
        }}
      />
    </div>
  );
}
