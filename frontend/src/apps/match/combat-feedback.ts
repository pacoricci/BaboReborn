// Accepted session changes drive presentation; prediction alone sounds local primary fire.
import type { Vec2, Vec3 } from '../../core/geometry';
import type { Shot } from '../../core/simulation';
import type { GameSignalKind, RemotePlayer, Match } from '../../contracts/session';
import { PHOTON } from '../../gameconfig/tuning';
import { DamageFeedback } from '../../presentation/effects/damage-feedback';
import type { ShotView, PlayerView } from '../../presentation/view';
import type { SnapshotChange, EventChange } from './session';

// This application port names feedback only; the adapter owns files, gain and Web Audio.
type FeedbackSample =
  | GameSignalKind
  | 'shield-hit'
  | 'death'
  | 'round-start'
  | 'round-end'
  | 'victory'
  | 'defeat'
  | 'connected'
  | 'disconnected'
  | 'rocket-explosion'
  | 'item-impact'
  | 'player-impact'
  | 'photon-impact'
  | 'flame-impact'
  | 'damage'
  | 'explosion'
  | 'knives'
  | 'ricochet'
  | 'flag-take'
  | 'flag-drop'
  | 'flag-return'
  | 'flag-capture';

interface CombatSound {
  sustain(kind: 'photon-loop', position: Vec2, seconds: number): void;
  shot(kind?: string, position?: Vec2): void;
  sample(kind: FeedbackSample, position?: Vec2): void;
  cue(kind: 'round' | 'death' | 'hit'): void;
  setListener(position: Vec2): void;
  stop(): void;
}
interface CombatScene {
  blood(position: Vec2, damage: number): void;
  clearBlood(): void;
  shot(shot: ShotView, actorID?: number): void;
  explosion(position: Vec3, radius: number): void;
  reset(player: Readonly<PlayerView>): void;
}
export class CombatFeedback {
  readonly damage = new DamageFeedback();
  hitUntil = 0;

  constructor(
    private audio: CombatSound,
    private scene: () => CombatScene | null,
  ) {}

  reset(): void {
    this.audio.stop();
    this.damage.reset();
    this.hitUntil = 0;
  }

  predicted(shot: Shot | null): void {
    if (!shot) return;
    this.audio.shot(shot.kind);
    for (const pellet of shot.pellets ?? [shot]) this.scene()?.shot(pellet);
  }

  receive(change: SnapshotChange, own: RemotePlayer): void {
    if (change.lifeChanged || change.phaseChanged) {
      this.damage.reset();
      this.hitUntil = 0;
    }
    if (change.lifeChanged) this.scene()?.reset(own.state);
    if (change.phaseChanged) {
      this.audio.stop();
      this.scene()?.clearBlood();
    }
    this.audio.setListener(own.state);
  }

  receiveEvents(
    change: EventChange,
    own: RemotePlayer,
    now: number,
    players: RemotePlayer[],
    match?: Match,
  ): void {
    this.audio.setListener(own.state);
    let confirmedHit = false;
    for (const event of change.events) {
      const personal = event.ownerId === own.id && event.life === own.life;
      switch (event.kind) {
        case 'hit':
          if (personal) confirmedHit = true;
          break;
        case 'damage':
          if (personal) {
            this.damage.hit(event.amount, now);
            this.audio.sample('damage');
          }
          if (players.some((p) => p.id === event.ownerId && p.life === event.life))
            this.scene()?.blood(event.position, event.amount);
          break;
        case 'death':
          if (personal) this.audio.cue('death');
          else if (event.ownerId !== own.id) this.audio.sample('death', event.position);
          break;
        case 'phase':
          this.audio.sample(event.phase === 'playing' ? 'round-start' : roundResult(own, match));
          break;
        case 'signal': {
          const pickup =
            event.signal === 'pickup-health' ||
            event.signal === 'pickup-equipment' ||
            event.signal === 'pickup-grenade';
          if (!pickup || personal)
            this.audio.sample(event.signal, pickup ? undefined : event.position);
          break;
        }
        case 'activity':
          if (event.activity.kind !== 'kill') this.audio.sample(event.activity.kind);
          break;
      }
    }
    let impacts = 0;
    for (const cue of change.cues) {
      if (cue.kind === 'shot') {
        const remote = cue.ownerId !== own.id || cue.shot.kind === 'minibot';
        if (remote) this.audio.shot(cue.shot.kind, cue.shot.from);
        for (const shot of cue.shot.pellets ?? [cue.shot])
          if (remote) this.scene()?.shot(shot, cue.ownerId);
        if (cue.shot.kind === 'photon')
          this.audio.sustain('photon-loop', cue.shot.from, PHOTON.durationSeconds);
        const surface = (cue.shot.pellets ?? [cue.shot]).find((shot) => shot.surface);
        if (surface && cue.shot.kind !== 'bazooka' && impacts < 3) {
          this.audio.sample(
            cue.shot.kind === 'photon'
              ? 'photon-impact'
              : cue.shot.kind === 'flamethrower'
                ? 'flame-impact'
                : 'ricochet',
            surface.to,
          );
          impacts++;
        }
      } else if (cue.kind === 'explosion' || cue.kind === 'rocket-explosion') {
        this.scene()?.explosion(cue.position, cue.radius);
        this.audio.sample(cue.kind, cue.position);
      } else this.audio.sample(cue.kind, cue.position);
    }
    if (confirmedHit) {
      this.hitUntil = now + 200;
      this.audio.cue('hit');
    }
  }
}

function roundResult(own: RemotePlayer, match?: Match): 'round-end' | 'victory' | 'defeat' {
  if (!match || own.status === 'spectator') return 'round-end';
  if (match.rules.mode !== 'dm') {
    if (own.team === 'none' || match.scores.blue === match.scores.red) return 'round-end';
    return own.team === (match.scores.blue > match.scores.red ? 'blue' : 'red')
      ? 'victory'
      : 'defeat';
  }
  const best = match.ranking[0];
  if (!best || match.ranking[1]?.score === best.score) return 'round-end';
  return best.id === own.id ? 'victory' : 'defeat';
}
