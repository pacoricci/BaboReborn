import { CLOSE, CLOSE_REASON, PROTOCOL } from '../../contracts/session';
import { centralPortal, matchPath, matchRoom } from '../../navigation/routes';

export type AccessEvent =
  | { type: 'checking' }
  | { type: 'room'; name: string; initial: boolean }
  | { type: 'portal'; url: string | null }
  | { type: 'identity'; subject: string }
  | { type: 'open'; url: URL }
  | { type: 'failed'; message: string }
  | { type: 'leave'; notice: string }
  | { type: 'reconnecting' }
  | { type: 'replace' | 'clean'; url: URL };

interface AccessServices {
  rooms(): Promise<readonly { id: string; name: string }[]>;
  identity(): Promise<{ subject: string; central: string; expired: boolean }>;
  prepare(url: URL): Promise<{ url: URL; info: { name: string } }>;
  storage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
  // Return a cancellation function so page disposal also owns delayed navigation.
  schedule(action: () => void, delay: number): () => void;
}

// Admission and administrative recovery consume services, never page elements or sockets.
export class MatchAccess {
  readonly roomID: string;
  readonly invite: URL | null;
  url: URL;
  private addressError: Error | undefined;
  private administrativeRejoin: boolean;
  private rejoinKey: string;
  private cancelRetry: (() => void) | undefined;
  private disposed = false;

  constructor(
    private page: URL,
    context: { id: string; origin: string },
    private services: AccessServices,
    private emit: (event: AccessEvent) => void,
  ) {
    this.url = new URL('/ws', context.origin);
    this.url.protocol = new URL(context.origin).protocol === 'https:' ? 'wss:' : 'ws:';
    let roomID = '';
    try {
      roomID = matchRoom(page);
      this.url.searchParams.set('room', roomID);
    } catch (error) {
      this.addressError = error instanceof Error ? error : new Error(String(error));
    }
    this.roomID = roomID;
    this.invite = roomID ? new URL(matchPath(roomID, context.id), page.origin) : null;
    this.rejoinKey = `baboreborn.rejoin.v1:${this.url.href}`;
    this.url.searchParams.set('v', String(PROTOCOL));
    this.administrativeRejoin = new URLSearchParams(page.search).has('rejoin');
  }

  async connect(): Promise<void> {
    if (this.disposed) return;
    try {
      if (this.addressError) throw this.addressError;
      this.emit({ type: 'checking' });
      const rooms = await this.services.rooms();
      if (this.disposed) return;
      const room = rooms.find((entry) => entry.id === this.roomID);
      if (!room) {
        this.emit({ type: 'room', name: 'Room unavailable', initial: false });
        throw new Error(
          'This room is no longer available. Return to the room catalog to choose another.',
        );
      }
      this.emit({ type: 'room', name: room.name, initial: true });
      const identity = await this.services.identity();
      if (this.disposed) return;
      this.emit({ type: 'portal', url: centralPortal(identity.central) });
      if (identity.expired) {
        this.leave(CLOSE_REASON.authenticationExpired);
        return;
      }
      this.emit({ type: 'identity', subject: identity.subject });
      const prepared = await this.services.prepare(this.url);
      if (this.disposed) return;
      this.url = prepared.url;
      this.emit({ type: 'room', name: prepared.info.name, initial: false });
      this.emit({ type: 'open', url: this.url });
    } catch (error) {
      if (this.disposed) return;
      if (this.addressError) this.emit({ type: 'room', name: 'No room selected', initial: false });
      else if (this.administrativeRejoin) {
        this.retry();
        return;
      }
      this.emit({
        type: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  closed(code: number, reason: string): boolean {
    if (this.disposed) return true;
    if (
      code === CLOSE.rejected ||
      code === CLOSE.removed ||
      code === CLOSE.roomClosed ||
      reason === CLOSE_REASON.sanctionActive ||
      reason === CLOSE_REASON.authenticationExpired
    ) {
      this.leave(reason || 'access_ended');
      return true;
    }
    if (code === CLOSE.roomFull && this.administrativeRejoin) {
      this.leave('room_capacity_reduced_no_slot_available');
      return true;
    }
    if (code === CLOSE.roomRestarted || this.administrativeRejoin) {
      this.administrativeRejoin = true;
      this.retry();
      return true;
    }
    return false;
  }

  welcome(): void {
    if (this.disposed) return;
    this.administrativeRejoin = false;
    this.cancelRetry?.();
    this.cancelRetry = undefined;
    try {
      this.services.storage.removeItem(this.rejoinKey);
    } catch {
      /* Reconnection succeeded even if optional storage is unavailable. */
    }
    const clean = new URL(this.page);
    clean.searchParams.delete('rejoin');
    this.emit({ type: 'clean', url: clean });
  }

  private retry(): void {
    if (this.cancelRetry) return;
    let attempts = 0;
    try {
      attempts = Number(this.services.storage.getItem(this.rejoinKey) ?? 0);
    } catch {
      /* Bounded fallback below. */
    }
    if (!Number.isInteger(attempts) || attempts < 0) {
      this.leave('room_restart_requires_manual_rejoin');
      return;
    }
    if (attempts >= 3) {
      this.leave('room_restart_reconnect_failed');
      return;
    }
    try {
      this.services.storage.setItem(this.rejoinKey, String(attempts + 1));
    } catch {
      this.leave('room_restart_requires_manual_rejoin');
      return;
    }
    this.emit({ type: 'reconnecting' });
    const next = new URL(this.page);
    next.searchParams.set('rejoin', '1');
    this.cancelRetry = this.services.schedule(
      () => {
        this.cancelRetry = undefined;
        if (!this.disposed) this.emit({ type: 'replace', url: next });
      },
      1000 * (attempts + 1),
    );
  }

  private leave(notice: string): void {
    // Terminal exits must cancel a previously scheduled administrative retry.
    this.dispose();
    this.emit({ type: 'leave', notice });
  }

  dispose(): void {
    this.disposed = true;
    this.cancelRetry?.();
    this.cancelRetry = undefined;
  }
}
