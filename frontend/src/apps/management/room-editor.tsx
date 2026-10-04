import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import { MapRotation } from './map-rotation';
import { Dialog } from '../../ui/dialog';
import type { RoomConfig } from '../../contracts/server';
import { MODES, MODE_NAMES } from '../../contracts/mode';
import { roomRulesChanged, validateRoom } from './rules';
import type { RoomEditor, StaffApplication } from './staff-application';

export function EditRoom(props: { app: StaffApplication; editor: RoomEditor }) {
  const state = props.app.state;
  const [config, setConfig] = createSignal<RoomConfig>({
    ...props.editor.config,
    rotation: [...props.editor.config.rotation],
  });
  const [error, setError] = createSignal('');
  const [review, setReview] = createSignal(false);
  const [choosingMaps, setChoosingMaps] = createSignal(false);
  function showMaps(value: boolean) {
    setChoosingMaps(value);
    queueMicrotask(() => {
      if (value) document.querySelector('#room-editor .dialog-body')?.scrollTo(0, 0);
      document.getElementById(value ? 'room-editor-title' : 'edit-room-maps')?.focus();
    });
  }
  // Polling must not remount the catalog cards and reload every preview.
  const maps = createMemo(() => state.rooms?.directory.maps ?? [], undefined, {
    equals: (before, after) =>
      before.length === after.length &&
      before.every((map, index) => {
        const next = after[index]!;
        return map.id === next.id && map.name === next.name && map.ctf === next.ctf;
      }),
  });
  const restart = () => !!props.editor.id && roomRulesChanged(props.editor.config, config());
  const changed = () => !props.editor.id || restart() || config().name !== props.editor.config.name;
  const patch = (value: Partial<RoomConfig>) => {
    setConfig((current) => ({ ...current, ...value }));
    setError('');
  };
  const preventLoss = (event: BeforeUnloadEvent) => {
    if (restart() || config().name !== props.editor.config.name) event.preventDefault();
  };
  window.addEventListener('beforeunload', preventLoss);
  onCleanup(() => window.removeEventListener('beforeunload', preventLoss));
  function cancel() {
    if (state.busy) return;
    if (choosingMaps()) {
      showMaps(false);
      return;
    }
    if (review()) {
      setReview(false);
      return;
    }
    if (
      (restart() || config().name !== props.editor.config.name) &&
      !window.confirm('Discard your unsaved room settings?')
    )
      return;
    props.app.closeEditor();
  }
  function submit() {
    const value = { ...config(), name: config().name.trim() };
    const invalidMap = value.rotation.some(
      (id) => !maps().some((map) => map.id === id && (value.mode !== 'ctf' || map.ctf)),
    );
    const problem =
      validateRoom(value) || (invalidMap ? 'Choose maps compatible with this mode.' : '');
    if (problem) {
      setError(problem);
      return;
    }
    setConfig(value);
    if (restart()) setReview(true);
    else void props.app.saveRoom(value, false);
  }
  const changes = () => {
    const before = props.editor.config;
    const after = config();
    const names = (ids: string[]) =>
      ids.map((id) => maps().find((map) => map.id === id)?.name ?? id).join(' → ');
    return [
      ['Name', before.name, after.name],
      ['Mode', before.mode.toUpperCase(), after.mode.toUpperCase()],
      ['Slots', String(before.capacity), String(after.capacity)],
      ['Bots', String(before.bots), String(after.bots)],
      ['Map rotation', names(before.rotation), names(after.rotation)],
      ['Score limit', String(before.scoreLimit), String(after.scoreLimit)],
      ['Minutes', String(before.timeLimitMinutes), String(after.timeLimitMinutes)],
      ['Respawn delay', `${before.respawnSeconds}s`, `${after.respawnSeconds}s`],
      ['Automatic respawn', before.forceRespawn ? 'On' : 'Off', after.forceRespawn ? 'On' : 'Off'],
    ].filter(([, old, next]) => old !== next);
  };
  return (
    <Dialog
      id="room-dialog"
      labelledBy="room-editor-title"
      fallbackFocus="management-title"
      cancel={cancel}
    >
      <form
        id="room-editor"
        onSubmit={(event) => {
          event.preventDefault();
          if (choosingMaps()) return;
          if (review()) void props.app.saveRoom(config(), true);
          else submit();
        }}
      >
        <header class="dialog-heading">
          <div>
            <p class="eyebrow">{props.editor.id ? props.editor.config.name : 'New room'}</p>
            <h2 id="room-editor-title" tabIndex={-1}>
              {choosingMaps()
                ? 'Map rotation'
                : review()
                  ? 'Review room changes'
                  : props.editor.id
                    ? 'Configure room'
                    : 'Create room'}
            </h2>
          </div>
        </header>
        <div class="dialog-body">
          <Show when={choosingMaps()}>
            <MapRotation
              maps={maps()}
              rotation={config().rotation}
              mode={config().mode}
              disabled={state.busy || state.accessBlocked}
              change={(rotation) => patch({ rotation })}
            />
          </Show>
          <div hidden={choosingMaps()}>
            <Show
              when={!review()}
              fallback={
                <>
                  <p class="notice">
                    This restarts “{props.editor.config.name}” after a 10-second warning. Connected
                    players return as spectators.
                  </p>
                  <table class="management-table">
                    <thead>
                      <tr>
                        <th>Setting</th>
                        <th>Current</th>
                        <th>New</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={changes()}>
                        {(change) => (
                          <tr>
                            <th>{change[0]}</th>
                            <td>{change[1]}</td>
                            <td>{change[2]}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </>
              }
            >
              <fieldset disabled={state.busy || state.accessBlocked} class="room-editor-grid">
                <section>
                  <h3>Room settings</h3>
                  <label>
                    Name
                    <input
                      name="name"
                      value={config().name}
                      required
                      maxlength="60"
                      onInput={(event) => patch({ name: event.currentTarget.value })}
                    />
                  </label>
                  <label>
                    Mode
                    <select
                      name="mode"
                      value={config().mode}
                      onChange={(event) => {
                        const mode = event.currentTarget.value as RoomConfig['mode'];
                        patch({ mode, scoreLimit: mode === 'ctf' ? 7 : 50 });
                      }}
                    >
                      <For each={MODES}>
                        {(code) => <option value={code}>{MODE_NAMES[code]}</option>}
                      </For>
                    </select>
                  </label>
                  <div class="field-pair">
                    <label>
                      Total slots
                      <input
                        type="number"
                        name="capacity"
                        min="2"
                        max="16"
                        required
                        value={config().capacity}
                        onInput={(event) => patch({ capacity: event.currentTarget.valueAsNumber })}
                      />
                    </label>
                    <label>
                      Bots
                      <input
                        type="number"
                        name="bots"
                        min="0"
                        max={config().capacity - 1}
                        required
                        value={config().bots}
                        onInput={(event) => patch({ bots: event.currentTarget.valueAsNumber })}
                      />
                    </label>
                  </div>
                  <p class="muted">
                    Bots use slots. At least one slot stays available for a person.
                  </p>
                  <details class="advanced-settings">
                    <summary>Match rules</summary>
                    <For
                      each={
                        [
                          { key: 'scoreLimit', label: 'Score limit', max: 1000 },
                          { key: 'timeLimitMinutes', label: 'Minutes', max: 180 },
                          { key: 'respawnSeconds', label: 'Respawn delay in seconds', max: 30 },
                        ] as const
                      }
                    >
                      {(field) => (
                        <label>
                          {field.label}
                          <input
                            name={field.key}
                            type="number"
                            min="0"
                            max={field.max}
                            required
                            value={config()[field.key]}
                            onInput={(event) =>
                              patch({ [field.key]: event.currentTarget.valueAsNumber })
                            }
                          />
                        </label>
                      )}
                    </For>
                    <p class="muted">Set score or time to 0 for no limit.</p>
                    <label class="check-label">
                      <input
                        type="checkbox"
                        name="forceRespawn"
                        checked={config().forceRespawn}
                        onChange={(event) => patch({ forceRespawn: event.currentTarget.checked })}
                      />
                      Automatic respawn
                    </label>
                  </details>
                  <Show when={restart()}>
                    <p class="muted">Changing match rules requires a restart.</p>
                  </Show>
                  <Show when={props.editor.id && !restart()}>
                    <p class="muted">Renaming keeps the match running.</p>
                  </Show>
                </section>
                <section class="rotation-summary" aria-label="Map rotation">
                  <h3>
                    Map rotation <small>{config().rotation.length}/16</small>
                  </h3>
                  <p>
                    {config()
                      .rotation.map((id) => maps().find((map) => map.id === id)?.name ?? id)
                      .join(' → ') || 'Choose at least one map.'}
                  </p>
                  <Show
                    when={config().rotation.some(
                      (id) =>
                        !maps().some(
                          (map) => map.id === id && (config().mode !== 'ctf' || map.ctf),
                        ),
                    )}
                  >
                    <p class="error">Choose maps compatible with this mode.</p>
                  </Show>
                  <button type="button" id="edit-room-maps" onClick={() => showMaps(true)}>
                    Edit maps
                  </button>
                </section>
              </fieldset>
            </Show>
          </div>
          <p class="feedback error" role="alert">
            {error() || state.error}
          </p>
        </div>
        <footer class="dialog-actions">
          <Show
            when={choosingMaps()}
            fallback={
              <>
                <button type="button" disabled={state.busy} onClick={cancel}>
                  {review() ? 'Back to settings' : 'Cancel'}
                </button>
                <button
                  class="primary"
                  type="submit"
                  disabled={state.busy || state.accessBlocked || !changed()}
                >
                  {state.busy
                    ? 'Saving…'
                    : review()
                      ? 'Restart room'
                      : restart()
                        ? 'Review restart'
                        : 'Save room'}
                </button>
              </>
            }
          >
            <button class="primary" type="button" onClick={() => showMaps(false)}>
              Done
            </button>
          </Show>
        </footer>
      </form>
    </Dialog>
  );
}
