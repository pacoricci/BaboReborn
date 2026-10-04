import { contentURL } from '../../content/runtime';
import { createEffect, createSignal, For, Show, onCleanup, onMount } from 'solid-js';
import { MAX_DECAL_SIZE, MIN_DECAL_SIZE } from '../../maps/decals';
import { render } from 'solid-js/web';
import type { EditorApplication } from './application';
import type { Symmetry } from './model';
import { themeByID } from '../../content/types';
import { LocalPackagePicker } from '../../presentation/ui/local-package-picker';
import { attachDrawing } from './drawing';

export function mountEditor(host: HTMLElement, app: EditorApplication, returnPath: string) {
  let game!: HTMLCanvasElement;
  let minimap!: HTMLCanvasElement;
  const dispose = render(() => {
    const [state, setState] = createSignal(app.snapshot());
    onCleanup(app.subscribe(setState));
    const [properties, setProperties] = createSignal({
      id: '',
      name: '',
      author: '',
      width: 32,
      height: 32,
    });
    let lastFields = -1;
    let wasTrial = false;
    let testButton!: HTMLButtonElement;
    let file!: HTMLInputElement;
    let canvas!: HTMLCanvasElement;
    let viewport!: HTMLDivElement;
    let drawing: ReturnType<typeof attachDrawing> | undefined;
    const theme = () => themeByID(state().content, state().map.theme);
    const selectedDecal = () => {
      const index = state().selectedDecal;
      return index === null ? undefined : state().map.decals?.[index];
    };
    const updateDecalNumber = (
      input: HTMLInputElement,
      field: 'x' | 'y' | 'w' | 'h' | 'angle',
      scale = 1,
    ) => {
      app.updateDecal({ [field]: input.valueAsNumber * scale });
      const current = selectedDecal();
      // Rejected edits restore the actual value instead of leaving an unsaved number visible.
      if (current)
        input.value = String(
          field === 'angle' ? Math.round(current[field] / scale) : current[field] / scale,
        );
    };
    createEffect(() => {
      const current = state();
      if (current.fieldsRevision !== lastFields) {
        lastFields = current.fieldsRevision;
        const { id, name, author, width, height } = current.map;
        setProperties({ id, name, author, width, height });
      }
      if (wasTrial && !current.trial) testButton.focus();
      wasTrial = current.trial;
    });
    onMount(() => {
      drawing = attachDrawing(canvas, viewport, app);
    });
    onCleanup(() => drawing?.dispose());
    return (
      <>
        <div id="workspace" hidden={state().trial}>
          <header>
            <a class="brand" href={returnPath}>
              BABO <span>Map builder</span>
            </a>
            <div class="actions">
              <button id="new" onClick={() => app.newDocument()}>
                New
              </button>
              <button id="open" onClick={() => file.click()}>
                Open map
              </button>
              <button
                id="export"
                disabled={state().report.errors.length > 0}
                onClick={() => app.save()}
              >
                Save map
              </button>
              <button
                ref={(element) => {
                  testButton = element;
                }}
                class="primary"
                id="test"
                disabled={state().report.errors.length > 0 || state().trialLoading}
                onClick={() => void app.test()}
              >
                Test map
              </button>
            </div>
            <input
              ref={(element) => {
                file = element;
              }}
              id="file"
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(event) => {
                const selected = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (selected) void app.openFile(selected);
              }}
            />
          </header>
          <main>
            <aside class="tools">
              <h1>Build an arena</h1>
              <label>
                Maps
                <select
                  id="catalog"
                  value=""
                  onChange={(event) => {
                    app.openCatalog(event.currentTarget.value);
                    event.currentTarget.value = '';
                  }}
                >
                  <option value="">Choose a map…</option>
                  <For each={app.maps}>
                    {(map) => (
                      <option value={map.id}>
                        {map.name} · {map.width} × {map.height}
                      </option>
                    )}
                  </For>
                </select>
              </label>
              <label>
                Theme
                <select
                  id="theme"
                  value={state().map.theme}
                  onChange={(event) => app.theme(event.currentTarget.value)}
                >
                  <For each={state().content.themes}>
                    {(theme) => <option value={theme.id}>{theme.name}</option>}
                  </For>
                </select>
              </label>
              <label>
                Wall material
                <select
                  id="material"
                  value={state().material}
                  onChange={(event) => app.selectMaterial(event.currentTarget.value)}
                >
                  <For each={Object.entries(theme().materials)}>
                    {([id, material]) => <option value={id}>{material.name}</option>}
                  </For>
                </select>
              </label>
              <div id="theme-packages">
                <LocalPackagePicker kind="theme" selected={(local) => app.preview(local?.theme)} />
              </div>
              <div class="scenario-swatches">
                <figure>
                  <img
                    id="theme-floor"
                    src={contentURL(theme().floor)}
                    crossorigin="anonymous"
                    alt="Scenario floor texture"
                  />
                  <figcaption>Floor</figcaption>
                </figure>
                <figure>
                  <img
                    id="theme-wall"
                    crossorigin="anonymous"
                    src={contentURL(
                      (theme().materials[state().material] ??
                        theme().materials[theme().defaultMaterial])!.wall,
                    )}
                    alt="Scenario wall texture"
                  />
                  <figcaption>Walls</figcaption>
                </figure>
              </div>
              <h2>Tools</h2>
              <div class="tool-grid" role="group" aria-label="Painting tools">
                <For
                  each={
                    [
                      { id: 'wall', label: '▧ Wall', key: '1' },
                      { id: 'material', label: 'Material', key: '' },
                      { id: 'floor', label: '□ Floor', key: '2' },
                      { id: 'spawn', label: '⊕ Spawn', key: '3' },
                      { id: 'erase', label: '⌫ Erase', key: '4' },
                      { id: 'decal', label: 'Decal', key: '5' },
                    ] as const
                  }
                >
                  {(tool) => (
                    <button
                      data-tool={tool.id}
                      aria-pressed={state().tool === tool.id}
                      onClick={() => app.selectTool(tool.id)}
                    >
                      {tool.label} <kbd>{tool.key}</kbd>
                    </button>
                  )}
                </For>
              </div>
              <Show when={state().tool === 'decal'}>
                <div class="decal-palette" role="group" aria-label="Decal assets">
                  <For each={state().content.decals}>
                    {(asset) => (
                      <button
                        type="button"
                        aria-label={asset.name}
                        aria-pressed={state().decalAsset === asset.id}
                        onClick={() => app.selectDecalAsset(asset.id)}
                      >
                        <img src={contentURL(asset.texture)} crossorigin="anonymous" alt="" />
                        <span>{asset.name}</span>
                      </button>
                    )}
                  </For>
                </div>
                <p class="hint">
                  Click to place or select. Drag to move. Right-click or Delete removes.
                </p>
                <Show when={selectedDecal()}>
                  {(decal) => (
                    <div class="decal-properties" role="group" aria-label="Selected decal">
                      <div class="dimensions">
                        <label>
                          X
                          <input
                            aria-label="Decal X"
                            type="number"
                            step="0.05"
                            value={decal().x}
                            onChange={(event) => updateDecalNumber(event.currentTarget, 'x')}
                          />
                        </label>
                        <label>
                          Y
                          <input
                            aria-label="Decal Y"
                            type="number"
                            step="0.05"
                            value={decal().y}
                            onChange={(event) => updateDecalNumber(event.currentTarget, 'y')}
                          />
                        </label>
                        <label>
                          Width
                          <input
                            aria-label="Decal width"
                            type="number"
                            min={MIN_DECAL_SIZE}
                            max={MAX_DECAL_SIZE}
                            step="0.05"
                            value={decal().w}
                            onChange={(event) => updateDecalNumber(event.currentTarget, 'w')}
                          />
                        </label>
                        <label>
                          Height
                          <input
                            aria-label="Decal height"
                            type="number"
                            min={MIN_DECAL_SIZE}
                            max={MAX_DECAL_SIZE}
                            step="0.05"
                            value={decal().h}
                            onChange={(event) => updateDecalNumber(event.currentTarget, 'h')}
                          />
                        </label>
                      </div>
                      <label>
                        Rotation
                        <input
                          aria-label="Decal rotation"
                          type="number"
                          min="-180"
                          max="180"
                          step="1"
                          value={Math.round((decal().angle * 180) / Math.PI)}
                          onChange={(event) =>
                            updateDecalNumber(event.currentTarget, 'angle', Math.PI / 180)
                          }
                        />
                      </label>
                      <label>
                        Opacity
                        <input
                          aria-label="Decal opacity"
                          type="range"
                          min="0"
                          max="100"
                          value={decal().opacity * 100}
                          onChange={(event) =>
                            app.updateDecal({ opacity: Number(event.currentTarget.value) / 100 })
                          }
                        />
                      </label>
                      <div class="actions">
                        <button type="button" onClick={() => app.duplicateDecal()}>
                          Duplicate
                        </button>
                        <button type="button" onClick={() => app.deleteDecal()}>
                          Remove decal
                        </button>
                      </div>
                    </div>
                  )}
                </Show>
              </Show>
              <Show when={state().tool !== 'decal'}>
                <label>
                  Wall height
                  <select
                    id="wall-height"
                    value={state().wallHeight}
                    onChange={(event) => app.selectHeight(Number(event.currentTarget.value))}
                  >
                    <For each={[1, 2, 3, 4, 5]}>
                      {(height) => (
                        <option value={height}>
                          {height} {height === 1 ? 'cell' : 'cells'}
                        </option>
                      )}
                    </For>
                  </select>
                </label>
                <label>
                  Mirror strokes
                  <select
                    id="symmetry"
                    value={state().symmetry}
                    onChange={(event) => app.selectSymmetry(event.currentTarget.value as Symmetry)}
                  >
                    <option value="none">Off</option>
                    <option value="horizontal">Left ↔ right</option>
                    <option value="vertical">Top ↔ bottom</option>
                    <option value="both">Both axes</option>
                  </select>
                </label>
              </Show>
              <form
                id="properties"
                onSubmit={(event) => {
                  event.preventDefault();
                  app.properties(properties());
                }}
              >
                <h2>Map</h2>
                <label>
                  Name
                  <input
                    id="name"
                    required
                    maxlength="80"
                    value={properties().name}
                    onInput={(event) =>
                      setProperties({ ...properties(), name: event.currentTarget.value })
                    }
                  />
                </label>
                <details>
                  <summary>File details</summary>
                  <label>
                    Map ID
                    <input
                      id="map-id"
                      required
                      maxlength="48"
                      pattern="[a-z0-9][a-z0-9-]{0,47}"
                      value={properties().id}
                      onInput={(event) =>
                        setProperties({ ...properties(), id: event.currentTarget.value })
                      }
                    />
                  </label>
                </details>
                <label>
                  Author
                  <input
                    id="author"
                    required
                    maxlength="80"
                    value={properties().author}
                    onInput={(event) =>
                      setProperties({ ...properties(), author: event.currentTarget.value })
                    }
                  />
                </label>
                <div class="dimensions">
                  <label>
                    Width
                    <input
                      id="width"
                      type="number"
                      min="8"
                      max="128"
                      required
                      value={properties().width}
                      onInput={(event) =>
                        setProperties({ ...properties(), width: event.currentTarget.valueAsNumber })
                      }
                    />
                  </label>
                  <label>
                    Height
                    <input
                      id="height"
                      type="number"
                      min="8"
                      max="128"
                      required
                      value={properties().height}
                      onInput={(event) =>
                        setProperties({
                          ...properties(),
                          height: event.currentTarget.valueAsNumber,
                        })
                      }
                    />
                  </label>
                </div>
                <button type="submit">Apply map settings</button>
                <p class="hint">
                  Making the map smaller crops its top and right edges. You can undo this.
                </p>
              </form>
            </aside>
            <section class="drawing" aria-label="Map workspace">
              <div class="canvas-toolbar">
                <div class="actions">
                  <button id="undo" disabled={!state().canUndo} onClick={() => app.undo()}>
                    Undo
                  </button>
                  <button id="redo" disabled={!state().canRedo} onClick={() => app.redo()}>
                    Redo
                  </button>
                </div>
                <div class="actions">
                  <button
                    id="zoom-out"
                    aria-label="Zoom out"
                    onClick={() => drawing?.zoom(1 / 1.25)}
                  >
                    −
                  </button>
                  <span id="zoom">{state().zoom}%</span>
                  <button id="zoom-in" aria-label="Zoom in" onClick={() => drawing?.zoom(1.25)}>
                    +
                  </button>
                  <button id="fit" onClick={() => app.fit()}>
                    Fit
                  </button>
                </div>
              </div>
              <div
                id="viewport"
                ref={(element) => {
                  viewport = element;
                }}
              >
                <canvas
                  ref={(element) => {
                    canvas = element;
                  }}
                  id="map"
                  tabindex="0"
                  aria-label="Map grid. Use arrow keys to move the cursor and Space to paint with the selected tool."
                  aria-describedby="grid-help"
                />
              </div>
              <div class="canvas-footer">
                <span id="cursor">
                  Cell {state().cursor.x}, {state().cursor.y} · {state().tool}
                  {state().tool === 'wall' ? ` · height ${state().wallHeight}` : ''}
                </span>
                <span id="summary">
                  {state().map.width} × {state().map.height} · {state().map.spawns.length} spawns
                  <Show when={state().map.decals?.length}>
                    {' '}
                    · {state().map.decals?.length} decals
                  </Show>
                </span>
              </div>
              <details class="grid-help">
                <summary>Controls</summary>
                <p class="hint" id="grid-help">
                  Drag to paint; right-click to erase. Arrow keys move the cursor; Space paints.
                  Ctrl/⌘ Z undoes; Ctrl/⌘ Shift Z redoes.
                </p>
              </details>
              <p id="notice" role="status">
                {state().notice}
              </p>
            </section>
            <aside class="checks">
              <h2>Map checks</h2>
              <p id="validation-summary">
                {state().report.errors.length
                  ? `${state().report.errors.length} issue${state().report.errors.length === 1 ? '' : 's'} to fix before export or testing.`
                  : state().report.warnings.length
                    ? 'Ready to test. Review these warnings.'
                    : 'Ready to test'}
              </p>
              <ul id="issues">
                <For each={state().report.errors}>
                  {(message) => <li class="error">{message}</li>}
                </For>
                <For each={state().report.warnings}>{(message) => <li>{message}</li>}</For>
              </ul>
              <h2>Spawn points</h2>
              <ol id="spawn-list">
                <For each={state().map.spawns}>
                  {(point, index) => (
                    <li>
                      {point.x.toFixed(1)}, {point.y.toFixed(1)}
                      <button
                        aria-label={`Remove spawn ${index() + 1}`}
                        onClick={() => app.removeSpawn(index())}
                      >
                        Remove
                      </button>
                    </li>
                  )}
                </For>
              </ol>
              <h2>Try it</h2>
              <label>
                Start from
                <select
                  id="test-spawn"
                  value={state().spawn}
                  onChange={(event) => app.selectSpawn(Number(event.currentTarget.value))}
                >
                  <For each={state().map.spawns}>
                    {(point, index) => (
                      <option value={index()}>
                        Spawn {index() + 1} ({point.x}, {point.y})
                      </option>
                    )}
                  </For>
                </select>
              </label>
              <details>
                <summary>Use in a match</summary>
                <p>Save the map and send it to the server owner to add it to the map list.</p>
              </details>
            </aside>
          </main>
        </div>
        <section id="trial" hidden={!state().trial} aria-label="Local map test">
          <canvas
            ref={(element) => {
              game = element;
            }}
            id="game"
            tabindex="0"
            aria-label="Map test. WASD moves; mouse aims; left-click fires; Escape returns to the editor."
          />
          <div class="trial-toolbar">
            <button id="back" onClick={() => app.endTrial()}>
              ← Back to builder
            </button>
            <span>WASD move · Mouse aim · Click fire · Esc back</span>
            <span id="trial-status">{state().trialStatus}</span>
          </div>
          <canvas
            ref={(element) => {
              minimap = element;
            }}
            id="minimap"
            width="180"
            height="180"
            aria-label="Test minimap"
          />
        </section>
      </>
    );
  }, host);
  return { dispose, canvases: () => ({ game, minimap }) };
}
