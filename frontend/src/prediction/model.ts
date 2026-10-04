import { MotionSampler } from '../core/motion';
import type { Wall, MovingBody } from '../core/geometry';
import { geometryWalls } from '../maps/types';
// Browser-independent prediction and interpolation; networking and rendering are adapters.
import { createCollisionGrid, resolveContact } from '../core/grid';
import { DEATHMATCH, MOVEMENT } from '../gameconfig/tuning';
import { bodyCopy, playerCopy, commandCopy, PREDICTION_TRACE_LIMITS } from './diagnostics';
import type { CollisionTrace, PredictionObserver, PredictionStep } from './diagnostics';
import type { Input, Player, Shot, WorldGeometry } from '../core/simulation';
import { stepPlayer } from '../core/simulation';
import { TICK_HZ } from '../core/timing';
import { PROTOCOL } from '../contracts/session';
import type {
  LocalPlayer,
  Command,
  Projectile,
  RemotePlayer,
  ShotView,
  Snapshot,
  Welcome,
} from '../contracts/session';

// Default remote playback delay behind the newest snapshot.
const INTERPOLATION_DELAY_MS = 100;
export class Prediction {
  player: Player | null = null;
  own: LocalPlayer | null = null;
  pending: Command[] = [];
  seq = 0;
  seed = { seed: 0 };
  lastTick = -1;
  playing = true;
  round = 0;
  correction: number | null = null;
  resets = 0;
  readonly geometry: WorldGeometry;
  private contacts: RemotePlayer[] = [];
  constructor(readonly welcome: Welcome) {
    if (welcome.version !== PROTOCOL || welcome.tickHz !== TICK_HZ)
      throw new Error('Incompatible server. Reload a matching client.');
    const walls = geometryWalls(welcome.arena);
    this.geometry = {
      walls,
      grid: createCollisionGrid(
        { x: 0, y: 0, w: welcome.arena.width, h: welcome.arena.height },
        walls,
      ),
    };
  }
  advance(
    input: Input,
    view?: ShotView,
    observe?: PredictionObserver,
  ): { command: Command; shot: Shot | null } | null {
    if (!this.playing || !this.player || this.own?.status !== 'alive' || this.pending.length >= 60)
      return null;
    const command: Command = {
      ...input,
      aim: { ...input.aim },
      seq: ++this.seq,
      life: this.own.life,
      ...(input.fire && view ? { view: { ...view } } : {}),
    };
    this.pending.push(command);
    return {
      command,
      shot: this.step(
        command,
        this.lastTick + this.pending.length,
        observe
          ? (step) =>
              observe({
                kind: 'advance',
                round: this.round,
                life: this.own!.life,
                sourceTick: this.lastTick,
                step,
              })
          : undefined,
      ),
    };
  }
  private step(
    command: Command,
    tick: number,
    observe?: (step: PredictionStep) => void,
  ): Shot | null {
    const player = this.player!;
    const before = observe ? bodyCopy(player) : undefined;
    const collisions: CollisionTrace[] | undefined = observe ? [] : undefined;
    let omittedCollisions = 0;
    const collision = observe
      ? (entry: CollisionTrace) => {
          if (collisions!.length < PREDICTION_TRACE_LIMITS.collisions) collisions!.push(entry);
          else omittedCollisions++;
        }
      : undefined;
    const grid = collision
      ? (before: MovingBody, after: MovingBody) => collision({ kind: 'grid', before, after })
      : undefined;
    const shot = stepPlayer(
      player,
      command,
      1 / this.welcome.tickHz,
      this.geometry,
      [],
      this.seed,
      this.welcome.shotGeometry,
      grid,
    );
    const delay = DEATHMATCH.contactDelaySeconds * this.welcome.tickHz;
    if (tick - this.own!.bornTick > delay) {
      // Remote positions stay authoritative; contact prediction never changes their state or HP.
      for (const other of this.contacts) {
        if (tick - other.bornTick <= delay) continue;
        const contactBefore =
          collision &&
          Math.hypot(player.x - other.state.x, player.y - other.state.y) <= 2 * MOVEMENT.radius
            ? bodyCopy(player)
            : undefined;
        const otherBody = contactBefore
          ? {
              id: other.id,
              life: other.life,
              born: other.bornTick,
              team: other.team,
              x: other.state.x,
              y: other.state.y,
            }
          : undefined;
        // Player response includes wall clearance; its nested grid trace is recorded separately.
        resolveContact(
          player,
          other.state,
          this.geometry.grid,
          this.own!.id > other.id ? -1 : 1,
          contactBefore
            ? (before, after) => collision!({ kind: 'grid', other: otherBody!, before, after })
            : undefined,
        );
        if (contactBefore)
          collision!({
            kind: 'player',
            other: otherBody!,
            before: contactBefore,
            after: bodyCopy(player),
          });
      }
    }
    if (observe)
      observe({
        tick,
        input: commandCopy(command),
        before: before!,
        after: bodyCopy(player),
        collisions: collisions!,
        omittedCollisions,
      });
    return shot;
  }
  reconcile(snapshot: Snapshot, collectDiagnostics = false, observe?: PredictionObserver): boolean {
    if (snapshot.version !== PROTOCOL || snapshot.tick <= this.lastTick) return false;
    const previousTick = this.lastTick;
    const remote = snapshot.players.find((p) => p.id === this.welcome.id);
    if (!remote || snapshot.local?.id !== this.welcome.id)
      throw new Error('State has no matching local checkpoint.');
    const own: LocalPlayer = { ...remote, ...snapshot.local };
    this.lastTick = snapshot.tick;
    const old = this.player;
    const previousAck = this.own?.ack ?? null;
    const previousLife = this.own?.life ?? null;
    const previousStatus = this.own?.status ?? null;
    const pendingBefore = observe ? this.pending.map((c) => c.seq) : undefined;
    const before = observe && old ? playerCopy(old) : null;
    const sameLife =
      this.round === snapshot.match.round &&
      this.own?.life === own.life &&
      this.own.status === own.status;
    this.round = snapshot.match.round;
    this.playing = snapshot.match.phase === 'playing';
    this.pending =
      sameLife && this.playing && own.status === 'alive'
        ? this.pending.filter((c) => c.seq > own.ack)
        : [];
    this.seq = Math.max(this.seq, own.ack);
    this.own = own;
    this.contacts = snapshot.players.filter((p) => p.id !== own.id && p.status === 'alive');
    this.player = {
      ...own.state,
      equipment: { ...own.state.equipment },
    };
    this.seed.seed = own.seed;
    const replayContacts: PredictionStep[] | undefined = observe ? [] : undefined;
    let omittedReplayContacts = 0;
    const replay = observe
      ? (step: PredictionStep) => {
          if (!step.collisions.length && !step.omittedCollisions) return;
          if (replayContacts!.length < PREDICTION_TRACE_LIMITS.replayContacts)
            replayContacts!.push(step);
          else omittedReplayContacts++;
        }
      : undefined;
    for (let i = 0; i < this.pending.length; i++)
      this.step(this.pending[i]!, snapshot.tick + i + 1, replay);
    this.correction = null;
    if (old && sameLife && own.status === 'alive') {
      if (collectDiagnostics || observe)
        this.correction = Math.hypot(this.player.x - old.x, this.player.y - old.y);
    } else this.resets++;
    if (observe) {
      const nearby = this.contacts.filter(
        (p) =>
          Math.hypot(p.state.x - this.player!.x, p.state.y - this.player!.y) <= 2 ||
          Math.hypot(p.state.x - own.state.x, p.state.y - own.state.y) <= 2 ||
          (before && Math.hypot(p.state.x - before.x, p.state.y - before.y) <= 2),
      );
      observe({
        kind: 'reconcile',
        round: this.round,
        life: own.life,
        tick: snapshot.tick,
        previousTick,
        id: own.id,
        born: own.bornTick,
        status: own.status,
        previousLife,
        previousStatus,
        capturedAtMs: snapshot.capturedAtMs,
        ack: own.ack,
        previousAck,
        pendingBefore: pendingBefore!,
        replayInputs: this.pending.map(commandCopy),
        before,
        authoritative: playerCopy(own.state),
        after: playerCopy(this.player),
        seed: own.seed,
        correction: this.correction,
        comparable: !!old && sameLife && own.status === 'alive',
        nearby: nearby.slice(0, PREDICTION_TRACE_LIMITS.nearby).map((p) => ({
          id: p.id,
          life: p.life,
          born: p.bornTick,
          team: p.team,
          state: { x: p.state.x, y: p.state.y },
        })),
        omittedNearby: Math.max(0, nearby.length - PREDICTION_TRACE_LIMITS.nearby),
        replayContacts: replayContacts!,
        omittedReplayContacts,
      });
    }
    return true;
  }
  release(): void {
    this.pending = [];
  }
}
function entityIndex<T extends { id: number }>(cache: WeakMap<T[], Map<number, T>>, values: T[]) {
  let index = cache.get(values);
  if (!index) {
    index = new Map(values.map((value) => [value.id, value]));
    cache.set(values, index);
  }
  return index;
}
export class Interpolation {
  private projectileIndex = new WeakMap<Projectile[], Map<number, Projectile>>();
  private itemIndex = new WeakMap<Snapshot['items'], Map<number, Snapshot['items'][number]>>();
  private motions: MotionSampler;
  constructor(walls: readonly Wall[] = [], height = 0.7) {
    this.motions = new MotionSampler(walls, height);
  }
  private samples: { snapshot: Snapshot; received: number }[] = [];
  private cursor: number | undefined;
  private renderedAt: number | undefined;
  private starved = false;
  private rate = 1;
  push(snapshot: Snapshot, received: number): void {
    const previous = this.samples.at(-1)?.snapshot;
    if (previous?.match.round === snapshot.match.round && snapshot.tick <= previous.tick) return;
    if (
      (previous && snapshot.tick - previous.tick > 60) ||
      previous?.match.round !== snapshot.match.round
    ) {
      this.samples = [];
      this.cursor = undefined;
      this.renderedAt = undefined;
    }
    this.samples.push({ snapshot, received });
    if (this.samples.length > 32) this.samples.shift();
  }
  private interval(now: number, tickHz: number, delayMs: number) {
    const latest = this.samples.at(-1);
    if (!latest) return undefined;
    const target = latest.snapshot.tick + ((now - latest.received - delayMs) * tickHz) / 1000;
    const elapsed = this.renderedAt === undefined ? 0 : Math.max(0, now - this.renderedAt);
    if (this.cursor === undefined || elapsed >= 500) {
      // Installation and a suspended render loop start a new playback timeline.
      this.cursor = target;
      this.rate = 1;
    } else if (elapsed > 0) {
      // Arrivals change playback speed, never its position. Catch up faster than
      // we slow down, so a burst cannot leave a long tail of extra aim latency.
      const advance = (elapsed * tickHz) / 1000;
      const errorMs = ((target - this.cursor - advance) * 1000) / tickHz;
      this.rate = 1 + Math.max(-0.1, Math.min(0.35, errorMs / 100));
      this.cursor += advance * this.rate;
    }
    if (this.renderedAt === undefined || now > this.renderedAt) {
      this.starved = this.cursor > latest.snapshot.tick;
      this.renderedAt = now;
    }
    // No extrapolation or accumulated playback debt while history is exhausted.
    this.cursor = Math.max(
      this.samples[0]!.snapshot.tick,
      Math.min(latest.snapshot.tick, this.cursor),
    );
    let a = this.samples[0]!,
      b = latest;
    for (const sample of this.samples) {
      if (sample.snapshot.tick <= this.cursor) a = sample;
      if (sample.snapshot.tick >= this.cursor) {
        b = sample;
        break;
      }
    }
    const alpha = Math.max(
      0,
      Math.min(1, (this.cursor - a.snapshot.tick) / (b.snapshot.tick - a.snapshot.tick || 1)),
    );
    return { a, b, latest, alpha };
  }
  diagnostics(now: number, tickHz: number, delayMs = INTERPOLATION_DELAY_MS) {
    this.interval(now, tickHz, delayMs);
    const latest = this.samples.at(-1);
    const ageMs = latest ? now - latest.received : null;
    return {
      samples: this.samples.length,
      latestAgeMs: ageMs,
      targetTick: this.cursor ?? null,
      playbackRate: this.rate,
      starved: !!latest && this.starved,
    };
  }

  view(now: number, tickHz: number, delayMs = INTERPOLATION_DELAY_MS): ShotView | undefined {
    const interval = this.interval(now, tickHz, delayMs);
    if (!interval) return undefined;
    const { a, b, latest, alpha } = interval;
    return {
      round: latest.snapshot.match.round,
      from: a.snapshot.tick,
      to: b.snapshot.tick,
      latest: latest.snapshot.tick,
      alpha,
    };
  }
  projectiles(now: number, tickHz: number, delayMs = INTERPOLATION_DELAY_MS): Projectile[] {
    const interval = this.interval(now, tickHz, delayMs);
    if (!interval) return [];
    const { a, b, latest, alpha } = interval;
    const tick = a.snapshot.tick + (b.snapshot.tick - a.snapshot.tick) * alpha;
    const earlier = entityIndex(this.projectileIndex, a.snapshot.projectiles);
    const later = entityIndex(this.projectileIndex, b.snapshot.projectiles);
    return latest.snapshot.projectiles.map((current) => {
      const before = earlier.get(current.id);
      const after = later.get(current.id);
      if (
        before &&
        (before.kind !== current.kind ||
          before.bornTick !== current.bornTick ||
          before.ownerId !== current.ownerId)
      )
        return current;
      const anchor = after && after.motionTick <= tick ? after : (before ?? current);
      return { ...anchor, ...this.motions.at(anchor, tick) };
    });
  }
  items(now: number, tickHz: number, delayMs = INTERPOLATION_DELAY_MS): Snapshot['items'] {
    const interval = this.interval(now, tickHz, delayMs);
    if (!interval) return [];
    const { a, b, latest, alpha } = interval;
    const tick = a.snapshot.tick + (b.snapshot.tick - a.snapshot.tick) * alpha;
    const earlier = entityIndex(this.itemIndex, a.snapshot.items);
    const later = entityIndex(this.itemIndex, b.snapshot.items);
    return latest.snapshot.items.map((current) => {
      if (current.motion === 'fixed' && current.motionTick <= tick) return current;
      const before = earlier.get(current.id);
      const after = later.get(current.id);
      const anchor = after && after.motionTick <= tick ? after : (before ?? current);
      return { ...anchor, ...this.motions.at(anchor, tick) };
    });
  }
  players(now: number, tickHz: number, delayMs = INTERPOLATION_DELAY_MS): RemotePlayer[] {
    const interval = this.interval(now, tickHz, delayMs);
    if (!interval) return [];
    const { a, b, latest, alpha } = interval;
    // Membership follows the latest authority; interpolation never resurrects disconnected players.
    return latest.snapshot.players.map((current) => {
      const before = a.snapshot.players.find((p) => p.id === current.id),
        after = b.snapshot.players.find((p) => p.id === current.id);
      if (
        !before ||
        !after ||
        before.life !== current.life ||
        after.life !== current.life ||
        before.status !== current.status ||
        after.status !== current.status
      )
        return current;
      const angle = Math.atan2(
        Math.sin(after.state.angle - before.state.angle),
        Math.cos(after.state.angle - before.state.angle),
      );
      return {
        ...current,
        state: {
          ...after.state,
          x: before.state.x + (after.state.x - before.state.x) * alpha,
          y: before.state.y + (after.state.y - before.state.y) * alpha,
          angle: before.state.angle + angle * alpha,
        },
      };
    });
  }
}
