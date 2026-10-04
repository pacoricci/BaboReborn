// Art attachments and fallback bounds, never collision or gameplay definitions.
import { PRIMARY_MODELS } from '../actors/arsenal';
import { SMG_MUZZLE } from '../../gameconfig/tuning';
export const WORLD_MODELS = [
  'wall',
  'health',
  'grenade',
  'molotov',
  'rocket',
  'minibot',
  'babo',
  'knives',
  'weapon-mount',
  'flag-blue',
  'flag-red',
  'base-blue',
  'base-red',
];
interface ModelDefinition {
  parts?: string[];
  cloneParts?: string[];
  clone?: boolean;
  offset?: [number, number, number];
  fallbackSize: [number, number, number];
  fallbackOffset?: [number, number, number];
}
export const MODEL_DEFINITIONS: Record<string, ModelDefinition> = Object.fromEntries(
  PRIMARY_MODELS.map((kind) => [
    kind,
    { fallbackSize: [0.08, 0.08, 0.4], fallbackOffset: [0, 0, 0.2] },
  ]),
);
MODEL_DEFINITIONS.smg = {
  fallbackSize: [0.08, 0.08, 0.4],
  fallbackOffset: [0, 0, -0.2],
  offset: [SMG_MUZZLE.right, SMG_MUZZLE.height, SMG_MUZZLE.forward],
};
MODEL_DEFINITIONS.chain!.parts = ['rotor'];
MODEL_DEFINITIONS.photon!.parts = ['charge'];
MODEL_DEFINITIONS.photon!.cloneParts = ['charge'];
for (const kind of WORLD_MODELS) MODEL_DEFINITIONS[kind] = { fallbackSize: [0.2, 0.15, 0.2] };
for (const team of ['blue', 'red']) {
  MODEL_DEFINITIONS[`flag-${team}`] = {
    fallbackSize: [0.04, 1, 0.04],
    fallbackOffset: [0, 0.5, 0],
  };
  MODEL_DEFINITIONS[`base-${team}`] = { fallbackSize: [1.3, 0.06, 1.3] };
}
MODEL_DEFINITIONS.babo = { clone: true, fallbackSize: [0.5, 0.5, 0.5] };
MODEL_DEFINITIONS.knives!.parts = Array.from({ length: 8 }, (_, i) => `blade-${i}`);
MODEL_DEFINITIONS.knives!.fallbackSize = [1.3, 0.04, 1.3];
MODEL_DEFINITIONS.knives!.fallbackOffset = [0, 0.25, 0];
MODEL_DEFINITIONS['weapon-mount'] = {
  parts: [...PRIMARY_MODELS],
  fallbackSize: [0.01, 0.01, 0.01],
  fallbackOffset: [0, 0.25, 0],
};
MODEL_DEFINITIONS.minibot!.parts = ['turret-head'];
MODEL_DEFINITIONS.wall = { clone: true, fallbackSize: [1, 1, 1] };
export const MODEL_NAMES = Object.keys(MODEL_DEFINITIONS);
