import { createQuery } from '@tanstack/solid-query';
import { createPageQueries } from '../../bootstrap/queries';
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import { render } from 'solid-js/web';
import { createStore, reconcile } from 'solid-js/store';
import type { CatalogRoom } from './catalog';
import { startWithContent } from '../../bootstrap/content';
import { Character, Options } from '../../player/preferences-view';
import { browserPreferences } from '../../player/preferences-browser';
import { parseRoomReference, signInPath } from '../../navigation/routes';
import { returnedNotice } from '../../navigation/notices';
import { RoomDetails } from './room-details';
import { parseCatalog, visibleRooms } from './catalog';
import { MODES, MODE_NAMES } from '../../contracts/mode';
import { roomLatency } from './latency';
import { FAVORITES_KEY, parseFavorites, toggleFavorite } from './favorites';
import { REQUEST_TIMEOUT_MS } from '../../network/timing';
import '../../ui/menu.css';
import './style.css';

const CATALOG_REFRESH_MS = 5000;

interface Account {
  account: string;
  expired: boolean;
  loginAvailable: boolean;
}
void startWithContent(() => {
  const unmount = render(() => {
    const preferences = browserPreferences();
    const latency = roomLatency();
    const [pings, setPings] = createSignal<Record<string, number | undefined>>({});
    function Ping(props: { origin: string }) {
      let cell!: HTMLTableCellElement;
      const [value, setValue] = createSignal<number>();
      // Catalog refreshes replace room objects without changing their server.
      const origin = createMemo(() => props.origin);
      createEffect(() => {
        const stop = latency.watch(cell, origin(), (value) => {
          setValue(value);
          setPings((previous) =>
            previous[origin()] === value ? previous : { ...previous, [origin()]: value },
          );
        });
        onCleanup(stop);
      });
      return (
        <td
          ref={(element) => {
            cell = element;
          }}
          class="room-ping"
          title={
            value() === undefined
              ? 'Server latency unavailable or measuring'
              : 'Round-trip latency to the game server'
          }
        >
          {value() === undefined ? '—' : `${Math.round(value()!)} ms`}
        </td>
      );
    }
    const [favorites, setFavorites] = createSignal<string[]>([]);
    const [storageNotice, setStorageNotice] = createSignal('');
    const [query, setQuery] = createSignal('');
    const [mode, setMode] = createSignal('');
    const [hideFull, setHideFull] = createSignal(false);
    const [withPlayers, setWithPlayers] = createSignal(false);
    const [sort, setSort] = createSignal<'recommended' | 'players' | 'ping'>('recommended');
    const [selected, setSelected] = createSignal<string>();
    const selectedRoom = () => rooms().find((room) => room.ref === selected());
    const filtered = () => !!(query() || mode() || hideFull() || withPlayers());
    const resetFilters = () => {
      setQuery('');
      setMode('');
      setHideFull(false);
      setWithPlayers(false);
    };
    const invitation = new URLSearchParams(location.search).get('room');
    const [accessError, setAccessError] = createSignal('');
    try {
      setFavorites(parseFavorites(localStorage.getItem(FAVORITES_KEY)));
    } catch {
      setStorageNotice('Favorites could not be restored.');
    }
    const page = location.pathname;
    const title = page === '/character' ? 'Character' : page === '/options' ? 'Options' : 'Rooms';
    document.title = `Babo · ${title}`;
    const client = createPageQueries();
    const catalogQuery = createQuery(
      () => ({
        queryKey: ['catalog'],
        enabled: page === '/',
        refetchInterval: CATALOG_REFRESH_MS,
        queryFn: async ({ signal }) => {
          const response = await fetch('/api/v1/rooms', {
            cache: 'no-store',
            redirect: 'error',
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
          });
          if (!response.ok) throw new Error('Room catalog temporarily unavailable.');
          return parseCatalog(await response.json());
        },
      }),
      () => client,
    );
    const accountQuery = createQuery(
      () => ({
        queryKey: ['account'],
        queryFn: async ({ signal }): Promise<Account> => {
          const response = await fetch('/api/v1/account', {
            cache: 'no-store',
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
          });
          if (!response.ok) throw new Error('Account unavailable.');
          return (await response.json()) as Account;
        },
      }),
      () => client,
    );
    const [catalogRooms, setCatalogRooms] = createStore<CatalogRoom[]>([]);
    // Preserve row identity and keyboard focus across catalog refreshes and sorting.
    createEffect(() => setCatalogRooms(reconcile(catalogQuery.data?.rooms ?? [], { key: 'ref' })));
    const rooms = () => (catalogQuery.isError ? [] : catalogRooms);
    const loading = () => page === '/' && catalogQuery.isPending;
    const error = () => catalogQuery.error?.message ?? '';
    const account = () => (accountQuery.isError ? undefined : accountQuery.data);
    createEffect(() =>
      setAccessError(accountQuery.isError ? 'Account unavailable. Retry before entering.' : ''),
    );
    const refresh = () => catalogQuery.refetch();
    const refreshAccount = () => accountQuery.refetch();
    function changeFavorite(ref: string) {
      const next = toggleFavorite(favorites(), ref);
      setFavorites(next);
      try {
        localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
        setStorageNotice('');
      } catch {
        setStorageNotice(
          'Favorites apply only to this visit because browser storage is unavailable.',
        );
      }
    }
    function enter(ref: string) {
      parseRoomReference(ref);
      if (!account()) {
        setAccessError('Check your account before entering.');
        return;
      }
      location.assign(`/rooms/${ref}`);
    }
    onCleanup(() => latency.dispose());
    const rows = () =>
      visibleRooms(rooms(), {
        query: query(),
        mode: mode(),
        hideFull: hideFull(),
        withPlayers: withPlayers(),
        sort: sort(),
        favorites: favorites(),
        pings: pings(),
      });
    return (
      <>
        <header class="rooms-header product-topbar">
          <a class="brand product-brand" href="/">
            BABO<span>REBORN</span>
          </a>
          <nav class="rooms-nav product-nav" aria-label="Main menu">
            <a href="/" aria-current={page === '/' ? 'page' : undefined}>
              Rooms
            </a>
            <a href="/character" aria-current={page === '/character' ? 'page' : undefined}>
              Character
            </a>
            <a href="/options" aria-current={page === '/options' ? 'page' : undefined}>
              Options
            </a>
          </nav>
          <nav class="product-account" aria-label="Account">
            <Show
              when={account()}
              fallback={
                <Show when={accessError()} fallback={<span class="account-state">Checking…</span>}>
                  <button onClick={() => void refreshAccount()}>Retry account</button>
                </Show>
              }
            >
              <Show
                when={account()?.account}
                fallback={
                  <>
                    <span class="account-state">Guest</span>
                    <Show when={account()?.loginAvailable}>
                      <a
                        class="button primary"
                        href={signInPath(invitation ? `/rooms/${invitation}` : page)}
                      >
                        Sign in
                      </a>
                    </Show>
                  </>
                }
              >
                <a href="/manage/servers">Servers</a>
                <a href="/account" aria-label="Account" title={account()?.account}>
                  Account
                </a>
              </Show>
            </Show>
          </nav>
        </header>
        <main class="rooms-layout" aria-label={title}>
          <h1 class="visually-hidden">{title}</h1>
          <Show when={page === '/character'}>
            <Character app={preferences} />
          </Show>
          <Show when={page === '/options'}>
            <Options app={preferences} />
          </Show>
          <Show when={page === '/'}>
            <p class="account-notice" role="status">
              {returnedNotice(new URLSearchParams(location.search).get('notice')) ||
                (account()?.expired ? 'Session expired. You’re browsing as Guest.' : '')}
            </p>
            <p role="alert">{accessError()}</p>
            <div class="catalog-filters">
              <label>
                Search rooms
                <input
                  type="search"
                  value={query()}
                  onInput={(e) => setQuery(e.currentTarget.value)}
                />
              </label>
              <label>
                Mode
                <select value={mode()} onChange={(e) => setMode(e.currentTarget.value)}>
                  <option value="">All modes</option>
                  <For each={MODES}>
                    {(code) => <option value={code}>{MODE_NAMES[code]}</option>}
                  </For>
                </select>
              </label>
              <label>
                Sort
                <select
                  value={sort()}
                  onChange={(e) =>
                    setSort(e.currentTarget.value as 'recommended' | 'players' | 'ping')
                  }
                >
                  <option value="recommended">Recommended</option>
                  <option value="players">Players</option>
                  <option value="ping">Ping</option>
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={hideFull()}
                  onChange={(e) => setHideFull(e.currentTarget.checked)}
                />
                Hide full
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={withPlayers()}
                  onChange={(e) => setWithPlayers(e.currentTarget.checked)}
                />
                With players
              </label>
              <Show when={filtered()}>
                <button onClick={resetFilters}>Clear filters</button>
              </Show>
              <button onClick={() => void refresh()}>Refresh</button>
            </div>
            <p role="status">{storageNotice()}</p>
            <p role="alert">{error()}</p>
            <Show when={loading()}>
              <p role="status">Loading rooms…</p>
            </Show>
            <Show when={!loading()}>
              <p role="status">
                {rows().length
                  ? `${rows().length} ${rows().length === 1 ? 'room' : 'rooms'}`
                  : error()
                    ? 'Retry when the catalog is available.'
                    : rooms().length || filtered()
                      ? 'No matching rooms.'
                      : 'No rooms available. Try again later.'}
              </p>
            </Show>
            <Show when={selectedRoom()}>
              {(room) => (
                <RoomDetails
                  room={room()}
                  close={() => setSelected(undefined)}
                  enter={() => enter(room().ref)}
                />
              )}
            </Show>
            <div class="room-table-scroll" role="region" aria-label="Rooms" tabindex="0">
              <table class="global-rooms">
                <thead>
                  <tr>
                    <th scope="col">Room</th>
                    <th scope="col">Mode</th>
                    <th scope="col">Map</th>
                    <th scope="col">Players / bots</th>
                    <th scope="col">Ping</th>
                    <th scope="col">
                      <span class="visually-hidden">Favorite</span>
                    </th>
                    <th scope="col">
                      <span class="visually-hidden">Enter room</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <For each={rows()}>
                    {(room) => (
                      <tr>
                        <th scope="row">
                          <button
                            class="room-name"
                            aria-label={`Details for ${room.name}`}
                            aria-haspopup="dialog"
                            onClick={() => setSelected(room.ref)}
                          >
                            {room.name}
                          </button>
                        </th>
                        <td>{MODE_NAMES[room.mode]}</td>
                        <td>{room.map}</td>
                        <td class="room-slots">
                          <Show
                            when={room.details}
                            fallback={
                              <span>
                                {room.occupied} / {room.capacity} slots
                              </span>
                            }
                          >
                            {(details) => (
                              <span>
                                {details().players} players · {details().bots} bots
                              </span>
                            )}
                          </Show>
                        </td>
                        <Ping origin={room.serverOrigin} />
                        <td>
                          <button
                            aria-label={`Favorite ${room.name}`}
                            aria-pressed={favorites().includes(room.ref)}
                            onClick={() => changeFavorite(room.ref)}
                          >
                            {favorites().includes(room.ref) ? '★' : '☆'}
                          </button>
                        </td>
                        <td class="room-action">
                          <button
                            class="primary"
                            data-room-ref={room.ref}
                            disabled={!!error() || room.occupied >= room.capacity}
                            onClick={() => enter(room.ref)}
                          >
                            {room.occupied >= room.capacity ? 'Room full' : 'Enter room'}
                          </button>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </main>
        <footer class="product-footer">
          <nav aria-label="Legal">
            <a href="/privacy.html">Privacy &amp; cookies</a>
            <a href="/terms.html">Terms</a>
            <a href="/credits.html">Credits</a>
          </nav>
        </footer>
      </>
    );
  }, document.getElementById('play-root')!);
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) unmount();
  });
});
