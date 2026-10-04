import type { LocalPlayer } from '../../contracts/session';

const SPAWN_CONFIRMATION_MS = 5000;
const UNCONFIRMED = 'Spawn not confirmed. Retry Join match or leave the room.';

type Schedule = (action: () => void, delayMs: number) => () => void;
type Life = Pick<LocalPlayer, 'status' | 'life'>;

// One explicit Join match request, from sending until authority confirms a spawn.
// It never sends by itself: callers own the connection and the retry decision.
export class JoinRequest {
  joining = false;
  problem = '';
  private interrupted: { round: number; life: number } | undefined;
  private cancelTimer: (() => void) | undefined;

  constructor(
    private readonly schedule: Schedule,
    private readonly changed: () => void,
  ) {}

  start(): void {
    this.cancel();
    this.joining = true;
    this.problem = '';
    this.cancelTimer = this.schedule(() => {
      this.cancel();
      this.problem = UNCONFIRMED;
      this.changed();
    }, SPAWN_CONFIRMATION_MS);
  }

  cancel(): void {
    this.joining = false;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  // A reinstallation may interrupt a pending request; remember the spectator life it started from.
  interrupt(round: number, own: Life | null | undefined): void {
    if (this.joining && own) this.interrupted = { round, life: own.life };
    this.cancel();
  }

  // A same-round resync that still has the original spectator life proves the
  // request did not spawn, so it should be retried; a newer life means it did.
  // Never retry across death or map changes. Returns whether to retry.
  resume(resyncRound: number | undefined, own: Life | null | undefined): boolean {
    const request = this.interrupted;
    this.interrupted = undefined;
    if (resyncRound === undefined || request?.round !== resyncRound || !own) return false;
    if (own.status === 'spectator' && own.life === request.life) return true;
    if (own.status !== 'spectator' && own.life > request.life) this.joining = true;
    return false;
  }

  // Authority settles a request by spawning the player or entering intermission.
  // Returns whether this snapshot confirmed the spawn.
  settle(own: Life | null | undefined, intermission: boolean): boolean {
    const joined = this.joining && own?.status !== 'spectator';
    if (joined || intermission) {
      this.cancel();
      this.problem = '';
    }
    return joined;
  }
}
