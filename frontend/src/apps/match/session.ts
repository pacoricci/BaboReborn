import { restoreSnapshot } from '../../contracts/snapshot';
import type { PredictionObserver } from '../../prediction/diagnostics';
import { ActivityFeed } from './activity-feed';
import { KillNotice } from './kill-notice';
import { MinimapReveals } from './minimap-reveals';
// Online application state and fixed-step scheduling; no browser, socket or renderer.
import { Prediction, Interpolation } from '../../prediction/model';
import type {
  Command,
  Snapshot,
  StateUpdate,
  Welcome,
  EventBatch,
  ShotView,
} from '../../contracts/session';
import type { Input, Shot } from '../../core/simulation';

export class OnlineSession {
  readonly prediction: Prediction;
  readonly activityFeed = new ActivityFeed();
  readonly killNotice = new KillNotice();
  readonly minimapReveals = new MinimapReveals();
  readonly interpolation: Interpolation;
  latest: Snapshot | null = null;
  receivedAt = 0;
  private outgoing: Command[] = [];
  private accumulator = 0;
  private lastSend = 0;
  eventThrough: number;
  private cueID = 0;
  private renderedView: ShotView | undefined;

  constructor(
    readonly welcome: Welcome,
    eventThrough = welcome.eventCut,
  ) {
    this.eventThrough = eventThrough;
    this.prediction = new Prediction(welcome);
    this.interpolation = new Interpolation(
      this.prediction.geometry.walls,
      welcome.shotGeometry.wallHeight,
    );
  }

  receive(
    update: StateUpdate,
    now: number,
    authorityNow: number,
    collectDiagnostics = false,
    observe?: PredictionObserver,
  ) {
    const message = restoreSnapshot(update, this.latest);
    const previous = this.prediction.own;
    const beforePhase = this.latest?.match.phase;
    const beforeRound = this.latest?.match.round;
    if (!this.prediction.reconcile(message, collectDiagnostics, observe)) return null;
    const own = this.prediction.own!;
    const age = Math.max(0, authorityNow - message.capturedAtMs);
    this.receivedAt = now - age;
    this.latest = message;
    this.minimapReveals.snapshot(message, now, authorityNow, this.welcome.tickHz);
    if (!beforePhase)
      this.activityFeed.receive(this.welcome.activities, message.match.round, now, authorityNow);
    // Playout stays behind received samples even at high RTT. Backdating this
    // buffer would target unavailable future samples and turn motion into steps.
    this.interpolation.push(message, now);
    const phaseChanged = beforePhase !== message.match.phase;
    const lifeChanged = previous?.life !== own.life;
    const statusChanged = previous?.status !== own.status;
    if (phaseChanged || lifeChanged || beforeRound !== message.match.round) this.killNotice.reset();
    if (phaseChanged || statusChanged || lifeChanged) this.release();
    return { phaseChanged, lifeChanged, statusChanged };
  }

  receiveEvents(message: EventBatch, now: number, authorityUpper: number) {
    const state = this.latest;
    if (!state) throw new Error('Events preceded initial state.');
    if (message.after > this.eventThrough) throw new Error('Required event history is missing.');
    if (message.through > state.eventCut || message.tick > state.tick)
      throw new Error('Events preceded their authority checkpoint.');
    const accepted = message.events.filter((event) => event.id > this.eventThrough);
    this.eventThrough = Math.max(this.eventThrough, message.through);
    const fresh = (event: { occurredAtMs: number; round: number }) =>
      event.round === state.match.round && Math.max(0, authorityUpper - event.occurredAtMs) < 250;
    for (const event of accepted) {
      this.minimapReveals.event(event, state, now, authorityUpper);
      if (event.kind === 'activity') {
        this.activityFeed.receive([event.activity], state.match.round, now, authorityUpper);
        if (fresh(event) && state.match.phase === 'playing')
          this.killNotice.receive(event.activity, this.welcome.id, now);
      }
    }
    const cues = message.cues.filter((cue) => {
      if (cue.id <= this.cueID) return false;
      this.cueID = cue.id;
      if (cue.tick > this.welcome.tick) this.minimapReveals.event(cue, state, now, authorityUpper);
      return cue.tick > this.welcome.tick && fresh(cue);
    });
    return { accepted, events: accepted.filter(fresh), cues };
  }

  advance(
    input: Input,
    elapsed: number,
    now: number,
    active: boolean,
    consumed: (shot: Shot | null) => void,
    observe?: PredictionObserver,
  ): void {
    if (!active || now - this.receivedAt >= 500 || this.prediction.own?.status !== 'alive') {
      this.accumulator = 0;
      return;
    }
    this.accumulator += Math.min(elapsed, 0.1);
    const step = 1 / this.welcome.tickHz;
    while (this.accumulator + 1e-10 >= step) {
      const result = this.prediction.advance(input, this.renderedView, observe);
      this.accumulator -= step;
      if (result) {
        this.outgoing.push(result.command);
        consumed(result.shot);
      }
    }
  }

  rendered(now: number): void {
    // Inputs sampled before the next render must retain the scene the user saw,
    // even if a newer snapshot arrived between frames.
    this.renderedView = this.interpolation.view(now, this.welcome.tickHz);
  }

  batch(now: number): Command[] | null {
    if (now - this.lastSend < 1000 / 60) return null;
    this.lastSend = now;
    if (!this.outgoing.length) return null;
    const commands = this.outgoing;
    this.outgoing = [];
    return commands;
  }

  private clearBatch(): void {
    this.outgoing = [];
    this.accumulator = 0;
  }
  release(): void {
    this.clearBatch();
    this.prediction.release();
    this.renderedView = undefined;
  }
}

export type SnapshotChange = NonNullable<ReturnType<OnlineSession['receive']>>;

export type EventChange = ReturnType<OnlineSession['receiveEvents']>;
