export interface WeaponVisual {
  shotAge: number;
  charge: number;
  reload: number;
}
import type { Appearance } from '../player/appearance';
import type { Vec2, Vec3 } from '../core/geometry';

export interface PlayerView extends Vec2 {
  nickname?: string | undefined;
  nicknameColors?: string | undefined;
  marker?: string | undefined;
  minimapColor?: string | undefined;
  appearance?: Appearance | undefined;
  life?: number | undefined;
  angle: number;
  weapon?: WeaponVisual;
  primary?: string | undefined;
  shield?: boolean;
  knives?: number;
  visible?: boolean;
}
export interface ActorView extends Vec2 {
  nickname?: string | undefined;
  nicknameColors?: string | undefined;
  marker?: string | undefined;
  minimapColor?: string | undefined;
  appearance?: Appearance | undefined;
  life?: number | undefined;
  id: number;
  angle?: number;
  weapon?: WeaponVisual;
  primary?: string | undefined;
  shield?: boolean;
  knives?: number;
  visible: boolean;
  minimapOpacity?: number;
  healthFraction: number;
  hitFlash: boolean;
}
export interface ObjectView extends Vec3 {
  throwMotion?: { age: number; moving: boolean };
  turret?: { angle: number; shotAge: number };
  angle?: number;
  id: number;
  kind: string;
}
export interface ArenaView {
  readonly camera?: { target: Readonly<Vec2>; height: number };
  readonly objects?: readonly ObjectView[];
  readonly player: Readonly<PlayerView>;
  readonly actors: readonly Readonly<ActorView>[];
}
export interface ShotView {
  readonly kind?: string;
  readonly from: Readonly<Vec3>;
  readonly to: Readonly<Vec3>;
  readonly killed: boolean;
}
