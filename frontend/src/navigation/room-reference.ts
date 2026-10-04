// A room reference names an installation and a persistent room, never a network address.
export function validRoomID(value: string | null): value is string {
  return value !== null && /^[a-f0-9]{32}$/.test(value);
}
export function roomReference(server: string, room: string): string {
  if (!validRoomID(server) || !validRoomID(room)) throw new Error('Invalid room reference.');
  return `${server}.${room}`;
}
export function parseRoomReference(value: string): { serverID: string; roomID: string } {
  const parts = value.split('.');
  if (parts.length !== 2 || !validRoomID(parts[0] ?? null) || !validRoomID(parts[1] ?? null))
    throw new Error('Invalid room reference. Choose a room from the catalog.');
  return { serverID: parts[0]!, roomID: parts[1]! };
}
