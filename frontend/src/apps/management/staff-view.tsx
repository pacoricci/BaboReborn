import { Nickname } from '../../ui/nickname';
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { Dialog } from '../../ui/dialog';
import { EditRoom } from './room-editor';
import type { StaffApplication, StaffData, StaffRole, Person } from './staff-application';
import type { Restriction } from '../../contracts/server';
import { MODE_NAMES } from '../../contracts/mode';

const timestamp = (value: string | null) =>
  value === null ? 'Permanent' : new Date(value).toLocaleString();
const titles: Record<string, string> = {
  room_create: 'Room created',
  room_restart: 'Match restarted',
  room_rename: 'Room renamed',
  room_close: 'Room closed',
  role: 'Staff role changed',
  sanction: 'Player restricted',
  revoke_sanction: 'Restriction revoked',
  kick: 'Player kicked',
  association: 'Installation updated',
};
export function Staff(props: { app: StaffApplication; active: boolean }) {
  const source = props.app.state;
  const [records, setRecords] = createStore<StaffData>({
    people: [],
    roles: [],
    restrictions: [],
    events: [],
  });
  createEffect(() => {
    const data = source.data;
    if (!data) return;
    // Reconcile by stable identity so live refreshes preserve focused controls.
    setRecords(
      'people',
      reconcile(
        data.people.map((person) => ({ ...person, key: `${person.subject}/${person.room}` })),
        { key: 'key' },
      ),
    );
    setRecords('roles', reconcile(data.roles, { key: 'account' }));
    setRecords('restrictions', reconcile(data.restrictions));
    setRecords('events', reconcile(data.events));
  });
  const state = source;
  const data = () => (source.data ? records : null);
  const canManage = createMemo(() => props.app.canManage());
  const canModerate = createMemo(() => props.app.canModerate());
  const [section, setSection] = createSignal('rooms');
  const selected = () =>
    !canManage() && ['rooms', 'staff'].includes(section()) ? 'players' : section();
  const [query, setQuery] = createSignal('');
  const [restrictionFilter, setRestrictionFilter] = createSignal('active');
  const [roleAccount, setRoleAccount] = createSignal('');
  const [roleValue, setRoleValue] = createSignal('moderator');
  const [confirmation, setConfirmation] = createSignal<{
    title: string;
    message: string;
    action(): Promise<boolean>;
  } | null>(null);
  const blocked = () => state.busy || state.accessBlocked || (!data() && state.loading);
  const rooms = () =>
    [...(state.rooms?.directory.rooms ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  const people = () => data()?.people ?? [];
  const roomName = (id: string) =>
    rooms().find((room) => room.id === id)?.info.name ?? 'Unavailable room';
  const personName = (subject: string) =>
    subject === state.rooms?.identity.subject
      ? 'You'
      : subject === 'central'
        ? 'Portal'
        : (people().find((person) => person.subject === subject)?.nickname ??
          (subject.startsWith('guest:')
            ? `Guest ${subject.slice(-8)}`
            : subject.startsWith('account:')
              ? `Account ${subject.slice(-8)}`
              : (rooms().find((room) => room.id === subject)?.info.name ??
                `ID ${subject.slice(-8)}`)));
  const personLabel = (subject: string) => {
    const text = personName(subject);
    const person = people().find(
      (person) => person.subject === subject && person.nickname === text,
    );
    return <Nickname text={text} colors={person?.nicknameColors} />;
  };
  const restrictionState = (ban: Restriction) =>
    ban.revokedAt !== null
      ? 'Revoked'
      : ban.expiresAt !== null && Date.parse(ban.expiresAt) <= Date.now()
        ? 'Expired'
        : 'Active';
  createEffect(() => {
    props.app.activate(props.active);
    if (!props.active || !canModerate()) {
      setConfirmation(null);
      setTarget('');
    }
  });
  onCleanup(() => props.app.activate(false));
  function confirm(title: string, message: string, action: () => Promise<boolean>) {
    setConfirmation({ title, message, action });
  }
  function moderate(person: Person) {
    setTarget(person.subject);
    setModerationAction('kick');
    setModerationReason('');
  }
  const [target, setTarget] = createSignal('');
  const [moderationAction, setModerationAction] = createSignal('kick');
  const [moderationReason, setModerationReason] = createSignal('');
  function editRole(role: StaffRole) {
    setRoleAccount(role.account);
    setRoleValue(role.role);
    document.getElementById('staff-account')?.focus();
  }
  return (
    <div id="staff-content">
      <Show when={canModerate()}>
        <div class="management-summary">
          <span class="state-badge">{state.rooms?.identity.role}</span>
          <span>{people().length} connected</span>
          <button
            type="button"
            disabled={state.loading || state.accessBlocked}
            onClick={() => void props.app.refresh()}
          >
            Refresh
          </button>
        </div>
        <p class="feedback" role="status">
          {!data() && state.loading
            ? 'Loading server information…'
            : state.editorLoading
              ? 'Loading room settings…'
              : state.message}
        </p>
        <p class="feedback error" role="alert">
          {state.error || state.loadError}
        </p>
        <div class="management-workspace">
          <nav class="section-nav" aria-label="Server sections">
            <For
              each={[
                ...(canManage() ? [{ id: 'rooms', label: 'Rooms' }] : []),
                { id: 'players', label: 'Players & moderation' },
                ...(canManage() ? [{ id: 'staff', label: 'Staff roles' }] : []),
                { id: 'restrictions', label: 'Restrictions' },
                { id: 'activity', label: 'Activity history' },
              ]}
            >
              {(item) => (
                <button
                  type="button"
                  aria-pressed={selected() === item.id}
                  onClick={() => {
                    setSection(item.id);
                    setQuery('');
                  }}
                >
                  {item.label}
                </button>
              )}
            </For>
          </nav>
          <section class="management-panel">
            <Show when={selected() === 'rooms'}>
              <div class="panel-heading">
                <div>
                  <h2>Rooms</h2>
                  <p class="muted">
                    {rooms().length} of {state.rooms?.directory.maxRooms} rooms
                  </p>
                </div>
                <button
                  id="room-new"
                  type="button"
                  class="primary"
                  disabled={blocked() || rooms().length >= (state.rooms?.directory.maxRooms ?? 0)}
                  onClick={() => void props.app.edit()}
                >
                  Create room
                </button>
              </div>
              <Show
                when={rooms().length}
                fallback={
                  <p class="empty-state">
                    No rooms yet. Create a room to make it available in Rooms.
                  </p>
                }
              >
                <div class="table-scroll">
                  <table class="management-table" id="managed-rooms">
                    <thead>
                      <tr>
                        <th>Room</th>
                        <th>Mode</th>
                        <th>Map</th>
                        <th>Slots used</th>
                        <th>
                          <span class="visually-hidden">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={rooms().map((room) => room.id)}>
                        {(id) => {
                          const room = () => rooms().find((room) => room.id === id)!;
                          const operation = () => state.roomOperations[room().id];
                          return (
                            <tr>
                              <th>
                                <h3>{room().info.name}</h3>
                                <Show when={operation()}>
                                  <p
                                    class="row-feedback"
                                    classList={{ error: !!operation()?.error }}
                                    role="status"
                                  >
                                    {operation()?.error || operation()?.message}
                                  </p>
                                </Show>
                              </th>
                              <td>{MODE_NAMES[room().info.mode]}</td>
                              <td>{room().info.map}</td>
                              <td>
                                {room().info.occupied} / {room().info.capacity}
                              </td>
                              <td>
                                <div class="inline-actions">
                                  <button
                                    type="button"
                                    disabled={blocked() || operation()?.pending}
                                    onClick={() => void props.app.edit(room().id)}
                                  >
                                    Configure
                                  </button>
                                  <button
                                    class="danger"
                                    type="button"
                                    disabled={blocked() || operation()?.pending}
                                    onClick={() => {
                                      const id = room().id;
                                      const name = room().info.name;
                                      confirm(
                                        `Close ${name}`,
                                        `Close this room after a 10-second warning? ${room().info.occupied} slots are occupied. Players return to the room list. The room configuration will be removed.`,
                                        () => {
                                          setConfirmation(null);
                                          return props.app.closeRoom(id);
                                        },
                                      );
                                    }}
                                  >
                                    Close room
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        }}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
            </Show>
            <Show when={selected() === 'players'}>
              <div class="panel-heading">
                <h2>Players &amp; moderation</h2>
                <span class="muted">{people().length} connected</span>
              </div>
              <Show
                when={people().length}
                fallback={
                  <p class="empty-state">
                    No players connected. Participants appear here when they enter a room.
                  </p>
                }
              >
                <label class="search-field">
                  Find a player
                  <input
                    type="search"
                    value={query()}
                    onInput={(event) => setQuery(event.currentTarget.value)}
                    placeholder="Nickname or Account ID"
                  />
                </label>
                <div class="table-scroll">
                  <table class="management-table">
                    <thead>
                      <tr>
                        <th>Player</th>
                        <th>Room</th>
                        <th>Identity</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For
                        each={people().filter((person) =>
                          `${person.nickname} ${person.subject}`
                            .toLowerCase()
                            .includes(query().toLowerCase()),
                        )}
                      >
                        {(person) => (
                          <tr>
                            <th>
                              <Nickname text={person.nickname} colors={person.nicknameColors} />
                            </th>
                            <td>{roomName(person.room)}</td>
                            <td>
                              <code title={person.subject}>
                                {person.subject.startsWith('guest:') ? 'Guest' : 'Account'} ·{' '}
                                {person.subject.slice(-8)}
                              </code>
                            </td>
                            <td>
                              <button
                                type="button"
                                disabled={
                                  blocked() || person.subject === state.rooms?.identity.subject
                                }
                                onClick={() => moderate(person)}
                              >
                                Moderate
                              </button>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
            </Show>
            <Show when={selected() === 'staff'}>
              <div class="panel-heading">
                <h2>Staff roles</h2>
              </div>
              <p class="muted">
                Admins manage rooms and moderators. Moderators can kick players and apply temporary
                restrictions. Only the owner appoints admins.
              </p>
              <div id="role-list">
                <For
                  each={data()?.roles.filter((role) => role.role !== 'player')}
                  fallback={<p class="empty-state">No staff appointed. Add an account below.</p>}
                >
                  {(role) => (
                    <div class="staff-row">
                      <div>
                        <strong>{personLabel(`account:${role.account}`)}</strong>
                        <code title={role.account}>{role.account}</code>
                      </div>
                      <span class="state-badge">{role.role}</span>
                      <button
                        type="button"
                        disabled={
                          blocked() ||
                          (role.role === 'admin' && state.rooms?.identity.role !== 'owner')
                        }
                        onClick={() => editRole(role)}
                      >
                        Change role
                      </button>
                      <button
                        type="button"
                        class="danger"
                        disabled={
                          blocked() ||
                          (role.role === 'admin' && state.rooms?.identity.role !== 'owner')
                        }
                        onClick={() =>
                          confirm(
                            'Remove staff access',
                            `Remove ${role.role} access for ${personName(`account:${role.account}`)} (${role.account})? They can still play.`,
                            () => props.app.saveRole(role.account, 'player'),
                          )
                        }
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </For>
              </div>
              <form
                id="role-form"
                class="management-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const account = roleAccount().trim();
                  const role = roleValue();
                  confirm(
                    'Confirm staff role',
                    `${personName(`account:${account}`)} · ${account}\nNew role: ${role}. ${role === 'admin' ? 'Can configure and close rooms, ban players and manage moderators.' : role === 'moderator' ? 'Can kick players and apply temporary restrictions.' : 'Staff access will be removed.'}`,
                    () => props.app.saveRole(account, role),
                  );
                }}
              >
                <h3>
                  {data()?.roles.some(
                    (role) => role.account === roleAccount() && role.role !== 'player',
                  )
                    ? 'Update staff member'
                    : 'Add staff member'}
                </h3>
                <p id="account-help" class="muted">
                  Ask the person to copy their ID from{' '}
                  <a href="/account" target="_blank" rel="noopener">
                    Account → Account ID
                  </a>
                  . Connected accounts are suggested below.
                </p>
                <fieldset disabled={blocked()}>
                  <div class="field-pair">
                    <label>
                      Account ID
                      <input
                        id="staff-account"
                        name="account"
                        value={roleAccount()}
                        onInput={(event) => setRoleAccount(event.currentTarget.value)}
                        aria-describedby="account-help"
                        list="known-accounts"
                        pattern="[a-f0-9]{32}"
                        minlength="32"
                        maxlength="32"
                        required
                      />
                    </label>
                    <label>
                      Role
                      <select
                        name="role"
                        value={roleValue()}
                        onChange={(event) => setRoleValue(event.currentTarget.value)}
                      >
                        <option value="moderator">Moderator</option>
                        <option value="player">Player (revoke staff)</option>
                        <option value="admin" disabled={state.rooms?.identity.role !== 'owner'}>
                          Admin
                        </option>
                      </select>
                    </label>
                  </div>
                  <datalist id="known-accounts">
                    <For each={people().filter((person) => person.subject.startsWith('account:'))}>
                      {(person) => (
                        <option value={person.subject.slice(8)}>{person.nickname}</option>
                      )}
                    </For>
                  </datalist>
                  <button class="primary" type="submit">
                    Review role
                  </button>
                </fieldset>
              </form>
            </Show>
            <Show when={selected() === 'restrictions'}>
              <div class="panel-heading">
                <h2>Restrictions</h2>
                <label>
                  Show
                  <select
                    value={restrictionFilter()}
                    onChange={(event) => setRestrictionFilter(event.currentTarget.value)}
                  >
                    <option value="active">Active</option>
                    <option value="history">Expired &amp; revoked</option>
                    <option value="all">All</option>
                  </select>
                </label>
              </div>
              <For
                each={data()?.restrictions.filter(
                  (ban) =>
                    restrictionFilter() === 'all' ||
                    (restrictionState(ban) === 'Active') === (restrictionFilter() === 'active'),
                )}
                fallback={
                  <p class="empty-state">
                    {restrictionFilter() === 'active'
                      ? 'No active restrictions.'
                      : 'No restrictions in this view.'}
                  </p>
                }
              >
                {(ban) => (
                  <article class="restriction-row">
                    <div>
                      <strong title={`${ban.kind}:${ban.target}`}>
                        {personLabel(`${ban.kind}:${ban.target}`)}
                      </strong>
                      <span class="state-badge">{restrictionState(ban)}</span>
                      <Show when={ban.reason}>
                        <p>{ban.reason}</p>
                      </Show>
                      <p class="muted">
                        {ban.expiresAt === null ? 'Permanent' : `Until ${timestamp(ban.expiresAt)}`}{' '}
                        · By {personLabel(ban.actor)}
                      </p>
                    </div>
                    <Show
                      when={
                        restrictionState(ban) === 'Active' &&
                        (canManage() ||
                          (ban.actor === state.rooms?.identity.subject && ban.expiresAt !== null))
                      }
                    >
                      <button
                        type="button"
                        disabled={blocked()}
                        onClick={() =>
                          confirm(
                            'Revoke restriction',
                            `Allow ${personName(`${ban.kind}:${ban.target}`)} (${ban.target}) to join again?`,
                            () => props.app.revoke(ban),
                          )
                        }
                      >
                        Revoke
                      </button>
                    </Show>
                  </article>
                )}
              </For>
            </Show>
            <Show when={selected() === 'activity'}>
              <div class="panel-heading">
                <h2>Activity history</h2>
                <span class="muted">Latest 500 events · 180 days</span>
              </div>
              <label class="search-field">
                Find activity
                <input
                  type="search"
                  value={query()}
                  onInput={(event) => setQuery(event.currentTarget.value)}
                  placeholder="Room, account, action or reason"
                />
              </label>
              <div id="audit-list">
                <For
                  each={data()?.events.filter((event) =>
                    `${titles[event.action] ?? event.action} ${personName(event.target)} ${event.details?.name ?? ''} ${event.actor} ${event.reason}`
                      .toLowerCase()
                      .includes(query().toLowerCase()),
                  )}
                  fallback={<p class="empty-state">No activity in this view.</p>}
                >
                  {(event) => (
                    <article class="activity-row">
                      <time>{timestamp(event.createdAt)}</time>
                      <div>
                        <strong>{titles[event.action] ?? event.action.replaceAll('_', ' ')}</strong>
                        <p>
                          {event.action === 'association'
                            ? 'This server'
                            : event.details?.name || personLabel(event.target)}
                          {event.details?.role ? ` → ${event.details.role}` : ''}
                          {event.reason ? ` · ${event.reason}` : ''}
                        </p>
                        <p class="muted">By {personLabel(event.actor)}</p>
                        <details>
                          <summary>Identifiers</summary>
                          <code>
                            {event.actor} → {event.target}
                          </code>
                        </details>
                      </div>
                    </article>
                  )}
                </For>
              </div>
            </Show>
          </section>
        </div>
        <Show when={state.editor} keyed>
          {(editor) => <EditRoom app={props.app} editor={editor} />}
        </Show>
        <Show when={target()}>
          <Dialog
            labelledBy="moderation-title"
            fallbackFocus="management-title"
            cancel={() => {
              if (!state.busy) setTarget('');
            }}
          >
            <form
              class="management-form"
              onSubmit={(event) => {
                event.preventDefault();
                const action = moderationAction();
                confirm(
                  action === 'kick'
                    ? 'Kick player'
                    : action === '0'
                      ? 'Ban player permanently'
                      : 'Restrict player',
                  `${personName(target())} · ${target()}\n${action === 'kick' ? 'Disconnect this player. They can rejoin.' : action === '0' ? 'Prevent this player from joining until the restriction is revoked.' : `Prevent this player from joining for ${action} minutes.`}`,
                  async () => {
                    const result = await props.app.moderate(
                      target(),
                      action === 'kick' ? null : Number(action),
                      action === 'kick' ? '' : moderationReason(),
                    );
                    if (result) setTarget('');
                    return result;
                  },
                );
              }}
            >
              <h2 id="moderation-title">Moderate {personLabel(target())}</h2>
              <p class="muted mono">{target()}</p>
              <fieldset disabled={blocked()}>
                <label>
                  Action
                  <select
                    value={moderationAction()}
                    onChange={(event) => setModerationAction(event.currentTarget.value)}
                  >
                    <option value="kick">Kick</option>
                    <option value="5">Block for 5 minutes</option>
                    <option value="30">Block for 30 minutes</option>
                    <option value="1440">Block for 24 hours</option>
                    <option value="0" disabled={!canManage()}>
                      Permanent ban
                    </option>
                  </select>
                </label>
                <Show when={moderationAction() !== 'kick'}>
                  <label>
                    Reason (optional)
                    <input
                      maxlength="500"
                      value={moderationReason()}
                      onInput={(event) => setModerationReason(event.currentTarget.value)}
                    />
                  </label>
                </Show>
              </fieldset>
              <div class="dialog-actions">
                <button type="button" onClick={() => setTarget('')}>
                  Cancel
                </button>
                <button class="primary" type="submit" disabled={blocked()}>
                  Review action
                </button>
              </div>
            </form>
          </Dialog>
        </Show>
        <Show when={confirmation()}>
          {(current) => (
            <Dialog
              labelledBy="staff-confirm-title"
              fallbackFocus="management-title"
              cancel={() => {
                if (!state.busy) setConfirmation(null);
              }}
            >
              <form
                class="management-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void current()
                    .action()
                    .then((result) => {
                      if (result) setConfirmation(null);
                    });
                }}
              >
                <h2 id="staff-confirm-title">{current().title}</h2>
                <p class="confirmation-message">{current().message}</p>
                <p class="feedback error" role="alert">
                  {state.error}
                </p>
                <div class="dialog-actions">
                  <button type="button" disabled={state.busy} onClick={() => setConfirmation(null)}>
                    Cancel
                  </button>
                  <button class="primary" type="submit" disabled={blocked()}>
                    {state.busy ? 'Applying…' : 'Confirm'}
                  </button>
                </div>
              </form>
            </Dialog>
          )}
        </Show>
      </Show>
    </div>
  );
}
