import { roomReference, parseRoomReference } from './room-reference';
export { validRoomID, roomReference, parseRoomReference } from './room-reference';
export function matchPath(room: string, serverID: string): string {
  return `/rooms/${roomReference(serverID, room)}`;
}
export function matchRoom(page: URL): string {
  if (
    !page.pathname.startsWith('/rooms/') ||
    [...page.searchParams.keys()].some((k) => k !== 'rejoin') ||
    page.searchParams.getAll('rejoin').length > 1 ||
    (page.searchParams.has('rejoin') && page.searchParams.get('rejoin') !== '1')
  )
    throw new Error('Invalid invitation. Choose a room from the catalog.');
  return parseRoomReference(page.pathname.slice('/rooms/'.length)).roomID;
}
export function roomsPath(notice?: string, invitation?: string): string {
  const params = new URLSearchParams();
  if (notice) params.set('notice', notice);
  if (invitation) {
    parseRoomReference(invitation);
    params.set('room', invitation);
  }
  return `/rooms${params.size ? `?${params}` : ''}`;
}
export function signInPath(target = '/rooms'): string {
  return `/auth/login?${new URLSearchParams({ return: target })}`;
}
export function centralPortal(central: string): string | null {
  try {
    const url = new URL(central);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return new URL('/rooms', url).href;
  } catch {
    return null;
  }
}
