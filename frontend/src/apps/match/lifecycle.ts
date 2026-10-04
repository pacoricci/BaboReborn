import { MatchDiagnostics } from './diagnostic-history';
import type { DiagnosticData } from './diagnostic-history';
// Owns one connection, its session and the scene/engine lifetime across map changes.
// Factories isolate browser sockets and graphics so failure ordering is testable headlessly.
import type {
  AdministrationNotice,
  ClientMessage,
  Delivery,
  AuthorityTime,
  Welcome,
} from '../../contracts/session';
import { CLOSE } from '../../contracts/session';
import { OnlineSession } from './session';
import type { SnapshotChange, EventChange } from './session';

interface RenderEngine {
  stopRenderLoop(frame: () => void): void;
  runRenderLoop(frame: () => void): void;
  dispose(): void;
}
interface ArenaScene {
  readonly engine: RenderEngine;
  readonly scene: { dispose(): void };
}
interface MatchConnection {
  readonly connected: boolean;
  readonly rtt: number;
  readonly payloadBytesIn: number;
  readonly payloadBytesOut: number;
  readonly webSocketExtensions: string;
  send(message: ClientMessage): void;
  close(code?: number, reason?: string): void;
}
interface ConnectionEvents {
  diagnosticsEnabled?(): boolean;
  diagnostic?(
    kind: 'probe' | 'backpressure' | 'resync' | 'delivery' | 'receipt',
    now: number,
    data: DiagnosticData,
  ): void;
  message(message: Delivery, now: number, time: AuthorityTime): void;
  invalid(error: unknown): void;
  closed(code: number, reason: string): void;
  error(): void;
}
interface LifecycleOptions<Renderer extends ArenaScene> {
  now: () => number;
  frame: () => void;
  closed?(code: number, reason: string): boolean;
  administration?(notice: AdministrationNotice): void;
  createEngine(): Renderer['engine'];
  createRenderer(message: Welcome, engine: Renderer['engine']): Renderer;
  loading(recovery: boolean): void;
  initialized(message: Welcome, recovery: boolean): void;
  loaded(message: Welcome): void;
  snapshot(change: SnapshotChange, now: number): void;
  events(change: EventChange, now: number): void;
  failed(message: string): void;
}

export class OnlineLifecycle<Renderer extends ArenaScene> {
  readonly diagnostics = new MatchDiagnostics();
  private lastSnapshotAt: number | undefined;
  session: OnlineSession | null = null;
  renderer: Renderer | null = null;
  connection: MatchConnection | null = null;
  ready = false;
  failure = '';
  // Keep the engine independently: replacement can fail after disposing the old scene.
  private engine: Renderer['engine'] | undefined;
  private disposed = false;
  private connectionID = '';
  private sequence = 0;
  private generation = 0;
  private lastRecovery = -Infinity;
  private lastStateAt = -Infinity;
  private awaitingRecovery = false;
  predictionObserver(now: number) {
    return this.diagnostics.predictionObserver(now, this.generation);
  }

  get recovering(): boolean {
    return this.awaitingRecovery;
  }

  constructor(private options: LifecycleOptions<Renderer>) {}

  connect(open: (events: ConnectionEvents) => MatchConnection): void {
    if (this.disposed || this.connection) throw new Error('Connection already opened or disposed.');
    this.connection = open({
      diagnosticsEnabled: () => this.diagnostics.enabled,
      diagnostic: (kind, now, data) => this.diagnostics.record(kind, now, data),
      message: (message, now, time) => this.receive(message, now, time),
      invalid: (error) =>
        this.fail(error instanceof Error ? error.message : 'Invalid server message.'),
      closed: (code, reason) => {
        if (this.diagnostics.enabled)
          this.diagnostics.record('closed', this.options.now(), { code, reason });
        if (this.disposed || this.failure) return;
        if (this.options.closed?.(code, reason)) return;
        this.fail(
          code === 1013
            ? 'Room full. Retry when a slot is available.'
            : !this.session
              ? 'Could not enter this room. Retry the connection.'
              : `Connection closed${reason ? `: ${reason}` : ''}. Reconnect to this room.`,
        );
      },
      error: () => this.fail('Could not reach this game server. Retry the connection.'),
    });
  }

  send(message: ClientMessage): void {
    if (!this.disposed) this.connection?.send(message);
  }

  private receive(frame: Delivery, now: number, authority: AuthorityTime): void {
    if (this.disposed || this.failure) throw new Error('Session no longer accepts deliveries.');
    if (this.connectionID && frame.connection !== this.connectionID)
      throw new Error('Delivery belongs to another connection.');
    if (frame.sequence <= this.sequence) return;
    if (frame.sequence !== this.sequence + 1) throw new Error('Delivery sequence has a gap.');
    const message = frame.body;
    const install = frame.kind === 'installation';
    if (frame.generation !== this.generation + (install ? 1 : 0))
      throw new Error('Unexpected installation generation.');
    if (!this.session && !install) throw new Error('Delivery preceded installation.');
    if (frame.kind === 'installation') {
      const message = frame.body;
      const previous = this.session;
      if (
        (!previous && message.type !== 'welcome') ||
        (previous &&
          (message.type === 'welcome' ||
            message.id !== previous.welcome.id ||
            message.round < previous.welcome.round ||
            (message.type === 'map' && message.round <= previous.welcome.round)))
      )
        throw new Error('Unexpected map transition.');
      const cursor = previous?.eventThrough ?? message.eventCut;
      if (frame.eventThrough !== cursor) throw new Error('Installation skipped required events.');
      const sameRound = previous?.welcome.round === message.round;
      previous?.release();
      this.ready = false;
      this.options.loading(sameRound);
      this.engine?.stopRenderLoop(this.options.frame);
      if (!sameRound) {
        this.renderer?.scene.dispose();
        this.renderer = null;
      }
      if (this.diagnostics.enabled)
        this.diagnostics.record('installation', now, {
          type: message.type,
          generation: frame.generation,
          round: message.round,
          tick: message.tick,
          map: message.arena.id,
        });
      this.lastSnapshotAt = undefined;
      this.session = new OnlineSession(message, cursor);
      this.session.prediction.seq = previous?.prediction.seq ?? 0;
      this.engine ??= this.options.createEngine();
      this.renderer ??= this.options.createRenderer(message, this.engine);
      this.engine = this.renderer.engine;
      const change = this.session.receive(
        message.state,
        now,
        authority.now,
        this.diagnostics.enabled,
        this.diagnostics.predictionObserver(now, frame.generation),
      );
      if (!change) throw new Error('Invalid installation checkpoint.');
      this.recordSnapshot(frame, now, authority);
      this.engine.runRenderLoop(this.options.frame);
      this.generation = frame.generation;
      // Scene construction belongs to the installation barrier, not to the
      // interval between ordinary states used to detect network pauses.
      this.lastStateAt = -Infinity;
      this.awaitingRecovery = false;
      this.ready = true;
      this.confirm(frame, true);
      // Initialization may issue profile/loadout commands, so it runs only after
      // the successful installation receipt is ordered ahead of those commands.
      this.options.initialized(message, sameRound);
      this.options.loaded(message);
      this.options.snapshot(change, now);
      return;
    }
    const session = this.session!;
    if (frame.kind === 'state') {
      const state = frame.body;
      if (state.match.round !== session.welcome.round) throw new Error('State has the wrong map.');
      // Arrival gaps detect a pause without treating stable network latency as
      // repeated congestion. Source age still bounds prediction and playback.
      const gap = Number.isFinite(this.lastStateAt) && now - this.lastStateAt >= 500;
      this.lastStateAt = now;
      if (gap && !this.awaitingRecovery && now - this.lastRecovery >= 1000) {
        session.release();
        this.awaitingRecovery = true;
        this.ready = false;
        this.options.loading(true);
        this.lastRecovery = now;
        if (this.diagnostics.enabled)
          this.diagnostics.record('resync', now, {
            reason: 'snapshot_gap',
            generation: this.generation,
          });
        this.send({ type: 'resync' });
      }
      const change = session.receive(
        state,
        now,
        authority.now,
        this.diagnostics.enabled,
        this.predictionObserver(now),
      );
      if (change) {
        this.recordSnapshot(frame, now, authority);
        this.ready = !this.awaitingRecovery;
        this.options.snapshot(change, now);
      }
    } else if (frame.kind === 'events' || frame.kind === 'cues') {
      if (frame.body.after !== session.eventThrough)
        throw new Error('Required event coverage is not contiguous.');
      this.options.events(session.receiveEvents(frame.body, now, authority.upper), now);
    } else if (message.type === 'administration') {
      this.options.administration?.({
        ...message,
        ...(message.deadlineAtMs === undefined
          ? {}
          : { deadlineAtMs: now + Math.max(0, message.deadlineAtMs - authority.upper) }),
      });
    }
    if (frame.eventThrough !== session.eventThrough)
      throw new Error('Invalid delivery event boundary.');
    this.confirm(frame, false);
  }

  private recordSnapshot(frame: Delivery, now: number, authority: AuthorityTime): void {
    if (!this.diagnostics.enabled) return;
    const session = this.session!;
    const state = session.latest!;
    const age = authority.now - state.capturedAtMs;
    this.diagnostics.record('snapshot', now, {
      tick: state.tick,
      round: state.match.round,
      generation: frame.generation,
      sequence: frame.sequence,
      connection: frame.connection,
      sentAtMs: frame.sentAtMs,
      capturedAtMs: state.capturedAtMs,
      intervalMs:
        this.lastSnapshotAt === undefined || this.lastSnapshotAt < this.diagnostics.startedAtMs!
          ? null
          : now - this.lastSnapshotAt,
      sourceAgeMs: Number.isFinite(age) ? Math.max(0, age) : null,
      clockUncertaintyMs: Number.isFinite(authority.upper) ? authority.upper - authority.now : null,
      correction: session.prediction.correction,
      resets: session.prediction.resets,
      pending: session.prediction.pending.length,
      ack: session.prediction.own!.ack,
      life: session.prediction.own!.life,
      status: session.prediction.own!.status,
    });
    this.lastSnapshotAt = now;
  }

  private confirm(frame: Delivery, immediate: boolean): void {
    this.connectionID = frame.connection;
    this.sequence = frame.sequence;
    this.send({
      type: 'receipt',
      immediate,
      receipt: {
        connection: frame.connection,
        sequence: frame.sequence,
        generation: frame.generation,
        eventThrough: frame.eventThrough,
      },
    });
  }

  fail(message: string): void {
    if (this.disposed || this.failure) return;
    this.ready = false;
    this.failure = message;
    if (this.diagnostics.enabled)
      this.diagnostics.record('failure', this.options.now(), { message });
    this.session?.release();
    this.connection?.close(CLOSE.rejected, 'session_failed');
    this.engine?.stopRenderLoop(this.options.frame);
    this.options.failed(message);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    this.session?.release();
    this.connection?.close();
    this.engine?.stopRenderLoop(this.options.frame);
    this.renderer?.scene.dispose();
    this.renderer = null;
    this.engine?.dispose();
    this.engine = undefined;
  }
}
