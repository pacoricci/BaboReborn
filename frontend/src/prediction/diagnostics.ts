import type { Command, RemotePlayer } from '../contracts/session';
import type { MovingBody, Vec2 } from '../core/geometry';
import type { Player } from '../core/simulation';

export const PREDICTION_TRACE_LIMITS = { collisions: 8, replayContacts: 16, nearby: 16 } as const;
export type CollisionTrace = {
  kind: 'grid' | 'player';
  other?: {
    id: number;
    life: number;
    born: number;
    team: RemotePlayer['team'];
    x: number;
    y: number;
  };
  before: MovingBody;
  after: MovingBody;
};
export interface PredictionStep {
  tick: number;
  input: Command;
  before: MovingBody;
  after: MovingBody;
  collisions: CollisionTrace[];
  omittedCollisions: number;
}
export type PredictionTrace =
  | { kind: 'advance'; round: number; life: number; sourceTick: number; step: PredictionStep }
  | {
      kind: 'reconcile';
      round: number;
      life: number;
      tick: number;
      previousTick: number;
      id: number;
      born: number;
      status: RemotePlayer['status'];
      previousLife: number | null;
      previousStatus: RemotePlayer['status'] | null;
      capturedAtMs: number;
      ack: number;
      previousAck: number | null;
      pendingBefore: number[];
      replayInputs: Command[];
      before: Player | null;
      authoritative: Player;
      after: Player;
      seed: number;
      correction: number | null;
      comparable: boolean;
      nearby: {
        id: number;
        life: number;
        born: number;
        team: RemotePlayer['team'];
        state: Vec2;
      }[];
      omittedNearby: number;
      replayContacts: PredictionStep[];
      omittedReplayContacts: number;
    };
export type PredictionObserver = (trace: PredictionTrace) => void;
export const bodyCopy = (p: MovingBody): MovingBody => ({ x: p.x, y: p.y, vx: p.vx, vy: p.vy });
export const playerCopy = (p: Player): Player => ({ ...p, equipment: { ...p.equipment } });
export const commandCopy = (c: Command): Command => ({
  ...c,
  aim: { ...c.aim },
  ...(c.view ? { view: { ...c.view } } : {}),
});
