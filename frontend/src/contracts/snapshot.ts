import type { EntityDelta, Snapshot, StateUpdate } from './session';

function restoreEntities<T extends { id: number }>(
  update: T[] | EntityDelta<T> | undefined,
  previous: T[] | undefined,
): T[] {
  if (Array.isArray(update)) return update;
  if (!previous) throw new Error('State has no installed entity list.');
  if (!update) return previous;
  const entities = new Map(previous.map((v) => [v.id, v]));
  for (const id of update.remove) {
    if (!entities.delete(id)) throw new Error('Removal has no installed entity.');
  }
  for (const value of update.upsert) entities.set(value.id, value);
  return [...entities.values()];
}

// The caller has already checked contiguous delivery order and generation.
// Complete installation states start a new baseline; arrays and metadata remain
// immutable so old interpolation/diagnostic samples cannot change retroactively.
export function restoreSnapshot(update: StateUpdate, previous: Snapshot | null): Snapshot {
  if (previous && previous.local?.id !== update.local?.id)
    throw new Error('Local identity changed without installation.');
  const baseline = previous?.match.round === update.match.round ? previous : null;
  const items = restoreEntities(update.items, baseline?.items);
  const projectiles = restoreEntities(update.projectiles, baseline?.projectiles);
  const flags = update.flags ?? baseline?.flags;
  if (!flags) throw new Error('State has no installed flag list.');
  const rules = update.match.rules ?? baseline?.match.rules;
  const scores = update.match.scores ?? baseline?.match.scores;
  const ranking = update.match.ranking ?? baseline?.match.ranking;
  if (!rules || !scores || !ranking) throw new Error('State has no installed match metadata.');
  const players = update.players.map((player) => {
    const before = baseline?.players.find((p) => p.id === player.id);
    const team = player.team ?? before?.team;
    const nickname = player.nickname ?? before?.nickname;
    const appearance = player.appearance ?? before?.appearance;
    if (team === undefined || nickname === undefined || appearance === undefined)
      throw new Error('State has no installed player metadata.');
    const nicknameColors =
      player.nickname !== undefined ? player.nicknameColors : before?.nicknameColors;
    return { ...player, team, nickname, nicknameColors, appearance };
  });
  // The stateless decoder cannot check these relationships while rules/team are
  // omitted. Validate them after restoration, before prediction or rendering.
  if (
    flags.length !== (rules.mode === 'ctf' ? 2 : 0) ||
    flags.some((flag) => {
      if (flag.state !== 'carried') return false;
      const carrier = players.find((p) => p.id === flag.carrierId);
      return !carrier || carrier.team === 'none' || carrier.team === flag.team;
    })
  )
    throw new Error('State flags disagree with installed rules or teams.');
  return {
    ...update,
    items,
    projectiles,
    flags,
    players,
    match: { ...update.match, rules, scores, ranking },
  };
}
