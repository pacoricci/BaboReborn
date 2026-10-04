// Cosmetic catalog and muzzle references; model construction lives in devtools/assets.
import type { ModelAssets, ModelNode } from '../assets/model-assets';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import {
  DUAL,
  CHAIN,
  SNIPER,
  BAZOOKA,
  PHOTON,
  FLAMETHROWER,
  SHOTGUN,
  SMG_MUZZLE,
} from '../../gameconfig/tuning';

export const ARSENAL_COLORS: Record<string, string> = {
  shotgun: '#c99865',
  dual: '#a9ccba',
  chain: '#c58c64',
  sniper: '#88afcf',
  bazooka: '#94b960',
  photon: '#73cfff',
  flamethrower: '#f3914f',
  rocket: '#ffaa55',
  minibot: '#c297f4',
};
const muzzleRules = {
  shotgun: { ...SHOTGUN, muzzleHeight: SMG_MUZZLE.height },
  dual: DUAL,
  chain: CHAIN,
  sniper: SNIPER,
  bazooka: BAZOOKA,
  photon: PHOTON,
  flamethrower: FLAMETHROWER,
};
export const PRIMARY_MODELS = ['smg', ...Object.keys(muzzleRules)];
export type PrimaryModel = ModelNode;
export function createArsenal(
  assets: ModelAssets,
  parent: TransformNode,
): Map<string, PrimaryModel> {
  return new Map(
    PRIMARY_MODELS.map((kind) => {
      const node = assets.create(kind, parent);
      node.setEnabled(false);
      return [kind, node];
    }),
  );
}
export function visualMuzzle(primary: string | undefined) {
  return primary ? muzzleRules[primary as keyof typeof muzzleRules] : undefined;
}
