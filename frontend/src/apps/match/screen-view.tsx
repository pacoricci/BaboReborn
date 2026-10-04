import { Nickname } from '../../ui/nickname';
import { isMenuShortcut } from './menu-shortcut';
import { SettingsPanel } from '../../player/settings-view';
import { actionLabels, bindingLabel } from '../../player/game-options';
import type { Action } from '../../player/game-options';
import type { PlayerSettings } from '../../player/player-preferences';
import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { render } from 'solid-js/web';
import { EQUIPMENT_NAMES, PRIMARIES, SECONDARIES } from '../../core/equipment';
import type { Primary, Secondary } from '../../core/equipment';
import { equipmentHelp } from '../../player/equipment-help';
import type { MatchScreen } from './screen';

interface MatchScreenCommands {
  help(): void;
  diagnostics(): void;
  join(): void;
  arena(): void;
  leave(): void;
  rooms: string;
  equipment(): void;
  retry(): void;
  select(primary: Primary, secondary: Secondary): void;
  options(patch: Partial<PlayerSettings>): void;
  copy(link: string): Promise<void>;
}
function RankingTable(props: { rows: MatchScreen['state']['results']['rows'] }) {
  return (
    <table>
      <thead>
        <tr>
          <For each={['#', 'Player', 'Score', 'Kills', 'Deaths']}>
            {(heading) => <th scope="col">{heading}</th>}
          </For>
        </tr>
      </thead>
      <tbody>
        <For each={props.rows}>
          {(row) => (
            <tr data-own={row.own ? '' : undefined}>
              <td>{row.place}</td>
              <th scope="row">
                <Nickname text={row.name} colors={row.nicknameColors} />
              </th>
              <td>{row.score}</td>
              <td>{row.kills}</td>
              <td>{row.deaths}</td>
            </tr>
          )}
        </For>
        <Show when={!props.rows.length}>
          <tr>
            <td colSpan={5} class="score-empty">
              No players yet
            </td>
          </tr>
        </Show>
      </tbody>
    </table>
  );
}

export function mountMatchScreen(
  host: HTMLElement,
  screen: MatchScreen,
  commands: MatchScreenCommands,
) {
  const dispose = render(() => {
    const state = screen.state;
    const [copyStatus, setCopyStatus] = createSignal('');
    const [copyFallback, setCopyFallback] = createSignal(false);
    const [fullscreen, setFullscreen] = createSignal(!!document.fullscreenElement);
    const [fullscreenPending, setFullscreenPending] = createSignal(false);
    const [fullscreenError, setFullscreenError] = createSignal('');
    const syncFullscreen = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', syncFullscreen);
    onCleanup(() => document.removeEventListener('fullscreenchange', syncFullscreen));
    const fullscreenShortcut = (event: KeyboardEvent) => {
      if (
        event.code !== 'KeyG' ||
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        !document.fullscreenEnabled ||
        (event.target instanceof Element &&
          event.target.closest('input, textarea, select, [contenteditable]'))
      )
        return;
      event.preventDefault();
      if (!event.repeat) void toggleFullscreen();
    };
    window.addEventListener('keydown', fullscreenShortcut);
    onCleanup(() => window.removeEventListener('keydown', fullscreenShortcut));
    const diagnosticsShortcut = (event: KeyboardEvent) => {
      if (
        (event.code !== 'KeyL' && event.code !== 'F8') ||
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        (event.target instanceof Element &&
          event.target.closest('input, textarea, select, [contenteditable]'))
      )
        return;
      event.preventDefault();
      if (!event.repeat) commands.diagnostics();
    };
    window.addEventListener('keydown', diagnosticsShortcut);
    onCleanup(() => window.removeEventListener('keydown', diagnosticsShortcut));
    let disposed = false;
    let menu!: HTMLElement;
    let help!: HTMLDialogElement;
    let primary!: HTMLButtonElement;
    let secondary!: HTMLButtonElement;
    const [picker, setPicker] = createSignal<'primary' | 'secondary' | null>(null);
    let options!: HTMLHeadingElement;
    let invite!: HTMLInputElement;
    let wasOpen = false;
    let previousPanel = 'match';
    onCleanup(() => {
      disposed = true;
    });
    // Clicking the arena around the menu returns to it like Esc. Press and release must both
    // land outside, so drags from sliders or selected text never dismiss the menu.
    let pressedOutside = false;
    const outside = (event: PointerEvent) =>
      event.button === 0 &&
      state.open &&
      !state.help &&
      event.target instanceof Node &&
      !menu.contains(event.target);
    const pressOutside = (event: PointerEvent) => {
      pressedOutside = outside(event);
    };
    const releaseOutside = (event: PointerEvent) => {
      if (pressedOutside && outside(event)) commands.arena();
      pressedOutside = false;
    };
    window.addEventListener('pointerdown', pressOutside);
    window.addEventListener('pointerup', releaseOutside);
    onCleanup(() => {
      window.removeEventListener('pointerdown', pressOutside);
      window.removeEventListener('pointerup', releaseOutside);
    });
    createEffect(
      on(
        () => [
          state.open,
          state.help,
          state.panel,
          state.ready,
          state.canJoin,
          state.joining,
          state.intermission,
          state.failed,
        ],
        () => {
          const current = state;
          if (current.help && !help.open) help.showModal();
          else if (!current.help && help.open) help.close();
          if (!current.open) setPicker(null);
          // Authority can remove the focused action on death, phase change or failure.
          if (current.open && !current.help) {
            if (current.panel !== previousPanel)
              (current.panel === 'match' ? primary : options).focus();
            else if (
              !wasOpen ||
              (document.activeElement instanceof HTMLElement &&
                (document.activeElement.closest('[hidden]') ||
                  document.activeElement.matches(':disabled')))
            )
              menu.focus();
          }
          wasOpen = current.open;
          previousPanel = current.panel;
        },
      ),
    );
    function panel(value: 'match' | 'options') {
      setPicker(null);
      screen.update({ panel: value });
    }
    async function toggleFullscreen() {
      if (fullscreenPending()) return;
      setFullscreenPending(true);
      setFullscreenError('');
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch {
        if (!disposed) setFullscreenError('Full screen unavailable. Try again.');
      } finally {
        if (!disposed) setFullscreenPending(false);
      }
    }
    async function copy() {
      if (!state.invite) return;
      try {
        await commands.copy(state.invite);
        if (!disposed) setCopyStatus('Link copied.');
      } catch {
        if (disposed) return;
        setCopyFallback(true);
        setCopyStatus('Select and copy the room link.');
        invite.select();
      }
    }
    const action = (callback: () => void) => (event: MouseEvent) => {
      event.preventDefault();
      callback();
    };
    return (
      <>
        <Show
          when={state.respawnSeconds !== null && !state.open && !state.help && !state.showScores}
        >
          <div id="respawn-countdown" role="status" aria-live="polite" aria-atomic="true">
            <span class="respawn-label">Respawn</span>
            <Show
              when={state.respawnSeconds! > 0}
              fallback={
                <span class="respawn-ready">
                  {state.autoRespawn
                    ? 'Respawning…'
                    : `${bindingLabel(state.settings.bindings.fire)} to respawn`}
                </span>
              }
            >
              <strong class="respawn-seconds">{state.respawnSeconds}</strong>
            </Show>
          </div>
        </Show>
        <dialog
          ref={(element) => {
            help = element;
          }}
          id="controls-help"
          aria-labelledby="controls-title"
          onCancel={(event) => {
            event.preventDefault();
            commands.help();
          }}
          onKeyDown={(event) => {
            if (isMenuShortcut(event)) {
              event.preventDefault();
              event.stopPropagation();
              if (!event.repeat) commands.help();
            }
          }}
        >
          <header class="controls-heading">
            <h2 id="controls-title">Controls</h2>
            <button class="text-action" onClick={() => commands.help()}>
              Close · H / Esc / M
            </button>
          </header>
          <dl class="match-controls">
            <For
              each={[
                ...Object.entries(actionLabels).map(([key, label]) => [
                  bindingLabel(state.settings.bindings[key as Action]),
                  label,
                ]),
                ['Mouse', 'Aim'],
                ['Arrow keys', 'Move'],
                ['Esc / M', 'Match menu'],
                ['H', 'Controls'],
                ['L / F8', 'Export diagnostics'],
                ['G', 'Toggle full screen'],
              ]}
            >
              {(control) => (
                <>
                  <dt>{control[0]}</dt>
                  <dd>{control[1]}</dd>
                </>
              )}
            </For>
          </dl>
          <p class="muted">
            {equipmentHelp(
              state.settings.primary,
              state.settings.secondary,
              bindingLabel(state.settings.bindings.fire),
              bindingLabel(state.settings.bindings.secondary),
            )}
          </p>
          <p class="muted">Each life includes 2 grenades and 1 Molotov.</p>
          <p class="muted">The match continues while you read.</p>
        </dialog>
        <main
          ref={(element) => {
            menu = element;
          }}
          id="online-menu"
          class="online-menu"
          tabindex="-1"
          aria-labelledby="title"
          hidden={!state.open}
          data-state={state.status}
        >
          <header class="menu-heading">
            <div>
              <p id="room-name">{state.room}</p>
              <h1 id="title" class="sr-only">
                {state.title}
              </h1>
              <p class="arena-summary">
                <span id="arena-name">{state.arena}</span>
                <span id="server-info">{state.serverInfo}</span>
              </p>
            </div>
            <button
              id="online-copy"
              class="text-action"
              type="button"
              disabled={!state.invite}
              onClick={() => void copy()}
            >
              Copy invite link
            </button>
          </header>
          <p id="connection" class="muted" role="status" hidden={state.ready}>
            {state.connection}
          </p>
          <input
            ref={(element) => {
              invite = element;
            }}
            id="online-invite"
            aria-label="Room link"
            readonly
            value={state.invite}
            hidden={!copyFallback()}
          />
          <p id="online-copy-status" class="muted" role="status">
            {copyStatus()}
          </p>
          <p id="notice" class="state-notice" role="status" hidden={state.hideNotice}>
            {state.notice}
          </p>
          <div id="menu-layout" class="menu-layout" hidden={state.failed || !state.hasSession}>
            <div class="menu-content">
              <section
                id="panel-match"
                class="menu-panel"
                aria-label="Equipment"
                hidden={state.panel !== 'match'}
              >
                <div class="loadout" hidden={!!picker()}>
                  <button
                    id="primary"
                    class="loadout-choice"
                    ref={(element) => {
                      primary = element;
                    }}
                    aria-label={`Primary: ${EQUIPMENT_NAMES[state.settings.primary]}`}
                    aria-expanded={picker() === 'primary'}
                    aria-controls="equipment-picker"
                    onClick={() => setPicker(picker() === 'primary' ? null : 'primary')}
                  >
                    <img
                      src={`/equipment/${state.settings.primary}.png`}
                      alt=""
                      width="160"
                      height="120"
                    />
                    <span class="equipment-slot">Primary</span>
                    <strong>{EQUIPMENT_NAMES[state.settings.primary]}</strong>
                    <span class="equipment-change">Change</span>
                  </button>
                  <button
                    id="secondary"
                    class="loadout-choice"
                    ref={(element) => {
                      secondary = element;
                    }}
                    aria-label={`Secondary: ${EQUIPMENT_NAMES[state.settings.secondary]}`}
                    aria-expanded={picker() === 'secondary'}
                    aria-controls="equipment-picker"
                    onClick={() => setPicker(picker() === 'secondary' ? null : 'secondary')}
                  >
                    <img
                      src={`/equipment/${state.settings.secondary}.png`}
                      alt=""
                      width="160"
                      height="120"
                    />
                    <span class="equipment-slot">Secondary</span>
                    <strong>{EQUIPMENT_NAMES[state.settings.secondary]}</strong>
                    <span class="equipment-change">Change</span>
                  </button>
                </div>
                <Show when={picker()}>
                  {(slot) => (
                    <fieldset
                      id="equipment-picker"
                      class="equipment-picker"
                      ref={(element) =>
                        queueMicrotask(() => {
                          if (!disposed && element.isConnected && state.open)
                            element.querySelector<HTMLInputElement>('input:checked')?.focus();
                        })
                      }
                    >
                      <legend>
                        {slot() === 'primary' ? 'Primary weapon' : 'Secondary equipment'}
                      </legend>
                      <div class="equipment-grid">
                        <For each={slot() === 'primary' ? PRIMARIES : SECONDARIES}>
                          {(weapon) => (
                            <label class="equipment-option">
                              <input
                                type="radio"
                                name="equipment"
                                value={weapon}
                                checked={state.settings[slot()] === weapon}
                                onChange={() => {
                                  if (slot() === 'primary')
                                    commands.select(weapon as Primary, state.settings.secondary);
                                  else commands.select(state.settings.primary, weapon as Secondary);
                                }}
                              />
                              <img
                                src={`/equipment/${weapon}.png`}
                                alt=""
                                width="160"
                                height="120"
                              />
                              <span>{EQUIPMENT_NAMES[weapon]}</span>
                            </label>
                          )}
                        </For>
                      </div>
                      <button
                        class="text-action"
                        onClick={() => {
                          const trigger = slot() === 'primary' ? primary : secondary;
                          setPicker(null);
                          trigger.focus();
                        }}
                      >
                        Done
                      </button>
                    </fieldset>
                  )}
                </Show>
                <p id="selection-status" class="muted" hidden={!state.selectionStatus}>
                  Applies next spawn.
                </p>
              </section>
              <section
                id="panel-options"
                class="menu-panel"
                hidden={state.panel !== 'options'}
                aria-labelledby="options-heading"
              >
                <div class="settings-heading">
                  <button
                    id="panel-back"
                    class="text-action"
                    hidden={state.panel === 'match'}
                    onClick={() => panel('match')}
                  >
                    Back
                  </button>
                  <h2
                    ref={(element) => {
                      options = element;
                    }}
                    id="options-heading"
                    tabindex="-1"
                  >
                    Settings
                  </h2>
                </div>
                <SettingsPanel
                  settings={state.settings}
                  change={(patch) => commands.options(patch)}
                />

                <button
                  class="text-action"
                  aria-keyshortcuts="L F8"
                  onClick={() => commands.diagnostics()}
                >
                  Export diagnostics · L
                </button>
                <Show when={state.diagnosticsNotice}>
                  <p class="muted" role="status">
                    {state.diagnosticsNotice}
                  </p>
                </Show>
              </section>
              <p id="preferences-status" class="muted" role="status">
                {state.preferencesStatus}
              </p>
            </div>
          </div>
          <footer class="menu-footer" hidden={state.panel !== 'match' && !state.failed}>
            <div class="menu-actions">
              <button
                id="join"
                hidden={!state.ready || !state.spectator}
                disabled={!state.canJoin}
                onClick={() => commands.join()}
              >
                {state.joining ? 'Joining…' : 'Play'}
              </button>
              <button
                id="watch"
                hidden={!state.ready || !state.spectator || state.intermission}
                disabled={!state.ready || state.joining}
                onClick={() => commands.arena()}
              >
                Spectate
              </button>
              <button
                id="resume"
                hidden={!state.ready || state.spectator || state.intermission}
                disabled={!state.ready || state.joining}
                onClick={() => commands.arena()}
              >
                {state.returnLabel}
              </button>
              <button
                id="view-results"
                hidden={!state.ready || !state.intermission}
                disabled={!state.ready || state.joining}
                onClick={() => commands.arena()}
              >
                View results
              </button>
              <button id="retry" hidden={!state.failed} onClick={() => commands.retry()}>
                {state.hasSession ? 'Reconnect' : 'Retry connection'}
              </button>
            </div>
            <div class="menu-links">
              <a
                href="/privacy.html"
                target="_blank"
                rel="noopener"
                aria-label="Privacy & cookies (new tab)"
              >
                Privacy &amp; cookies
              </a>
              <a href="/terms.html" target="_blank" rel="noopener" aria-label="Terms (new tab)">
                Terms
              </a>
              <a href="/credits.html" target="_blank" rel="noopener" aria-label="Credits (new tab)">
                Credits
              </a>
              <button
                class="text-action"
                id="fullscreen-toggle"
                hidden={!document.fullscreenEnabled}
                disabled={fullscreenPending()}
                aria-pressed={fullscreen()}
                aria-keyshortcuts="G"
                onClick={() => void toggleFullscreen()}
              >
                {fullscreen() ? 'Exit full screen · G' : 'Full screen · G'}
              </button>
              <button
                class="text-action"
                id="controls-toggle"
                hidden={!state.ready}
                onClick={() => commands.help()}
              >
                Controls · H
              </button>
              <button
                class="text-action"
                id="settings-toggle"
                hidden={state.panel !== 'match'}
                onClick={() => panel('options')}
              >
                Settings
              </button>
              <a href={commands.rooms} id="leave" onClick={action(() => commands.leave())}>
                {state.hasSession ? 'Leave room' : 'Back to rooms'}
              </a>
              <Show when={state.failed && state.portal}>
                <a id="all-servers" href={state.portal!}>
                  All rooms
                </a>
              </Show>
            </div>
          </footer>
          <p class="muted" role="status" hidden={!fullscreenError()}>
            {fullscreenError()}
          </p>
          <p id="reconnect-note" class="muted" hidden={!state.failed || !state.hasSession}>
            Reconnecting resets your score.
          </p>
        </main>
        <section
          id="standings"
          data-teams={state.results.teams ? '' : undefined}
          hidden={state.open || (!state.showScores && !state.results.intermission)}
          aria-label="Scoreboard"
        >
          <h2 id="round-title">{state.results.intermission ? 'Final scores' : 'Scoreboard'}</h2>
          <p id="result-summary">
            <Show when={state.results.winner} keyed fallback={state.results.summary}>
              {(winner) => (
                <>
                  <Nickname text={winner.nickname} colors={winner.nicknameColors} />
                  {state.results.summary.slice(winner.nickname.length)}
                </>
              )}
            </Show>
          </p>
          <div id="ranking">
            <Show when={state.results.teams} fallback={<RankingTable rows={state.results.rows} />}>
              <For each={state.results.teams}>
                {(team) => (
                  <section class="score-team" data-team={team.team} aria-label={team.label}>
                    <header class="score-team-heading">
                      <h3>{team.label}</h3>
                      <p>
                        <strong>{team.score}</strong> {team.unit}
                      </p>
                    </header>
                    <RankingTable
                      rows={state.results.rows.filter((row) => row.team === team.team)}
                    />
                  </section>
                )}
              </For>
            </Show>
          </div>
          <p id="round-status">{state.results.notice}</p>
          <div id="result-actions" class="result-actions" hidden={!state.results.intermission}>
            <button id="result-equipment" onClick={() => commands.equipment()}>
              Next spawn equipment
            </button>
            <a href={commands.rooms} id="result-leave" onClick={action(() => commands.leave())}>
              Leave room →
            </a>
          </div>
        </section>
        <div role="status" class="room-operation-warning">
          {state.warning}
        </div>
      </>
    );
  }, host);
  return { dispose };
}
