import { CLOSE_REASON } from '../contracts/session';

export function returnedNotice(returned: string | null): string {
  const notices: Record<string, string> = {
    [CLOSE_REASON.roomClosed]: 'This room was closed by server staff.',
    room_capacity_reduced_no_slot_available:
      'The room now has fewer slots. No slot was available when you reconnected.',
    [CLOSE_REASON.sanctionActive]:
      'You cannot join right now. Open the room to see your access restriction.',
    signed_out: 'Signed out.',
    [CLOSE_REASON.authenticationExpired]: 'Session expired. You’re browsing as Guest.',
    [CLOSE_REASON.kicked]: 'You were removed from the room by server staff.',
    room_restart_reconnect_failed:
      'The room restarted, but reconnecting did not succeed. Refresh the rooms and enter again.',
    room_restart_requires_manual_rejoin:
      'The room restarted. Enter it again to watch or join the new match.',
    [CLOSE_REASON.gameSessionReplaced]: 'Game session opened elsewhere.',
    session_replaced: 'You signed in elsewhere. Open Account to continue here.',
    access_ended: 'Your access to this room ended. Choose a room to continue.',
  };
  return returned ? (notices[returned] ?? returned.replaceAll('_', ' ')) : '';
}
