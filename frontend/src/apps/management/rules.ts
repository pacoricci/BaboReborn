import type { RoomConfig } from '../../contracts/server';
export function roomRulesChanged(before: RoomConfig, after: RoomConfig): boolean {
  return (
    (
      [
        'mode',
        'capacity',
        'bots',
        'scoreLimit',
        'timeLimitMinutes',
        'respawnSeconds',
        'forceRespawn',
      ] as const
    ).some((key) => before[key] !== after[key]) ||
    before.rotation.length !== after.rotation.length ||
    before.rotation.some((id, index) => id !== after.rotation[index])
  );
}
export function validateRoom(config: RoomConfig): string | null {
  if (!config.name.trim() || config.name.length > 60)
    return 'Enter a room name of 1–60 characters.';
  if (!['dm', 'tdm', 'ctf'].includes(config.mode)) return 'Choose a game mode.';
  for (const [value, min, max] of [
    [config.capacity, 2, 16],
    [config.bots, 0, 15],
    [config.scoreLimit, 0, 1000],
    [config.timeLimitMinutes, 0, 180],
    [config.respawnSeconds, 0, 30],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < min || value > max) return 'Check the room limits.';
  }
  if (config.bots >= config.capacity) return 'Leave at least one slot for a person.';
  if (!config.rotation.length || config.rotation.length > 16) return 'Choose 1–16 maps.';
  return null;
}
