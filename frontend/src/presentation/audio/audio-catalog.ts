// Gains balance the loudest 400 ms (EBU R128 momentary) by gameplay role.
// Automatic fire and detail cues sit below heavy shots; sustained loops stay in the background.
// Each take is calibrated separately; keep PCM recordings and player volume unchanged.
export const AUDIO_SAMPLES = {
  spawn: { file: 'coverage/spawn.wav', gain: 0.531 },
  'shield-end': { file: 'coverage/shield-end.wav', gain: 0.178 },
  'shield-hit': { file: 'coverage/shield-hit.wav', gain: 0.124 },
  'minibot-start': { file: 'coverage/minibot-start.wav', gain: 0.343 },
  'minibot-end': { file: 'coverage/minibot-end.wav', gain: 0.582 },
  'chain-ready': { file: 'coverage/chain-ready.wav', gain: 0.216 },
  'charge-ready': { file: 'coverage/charge-ready.wav', gain: 0.17 },
  'fire-loop': { file: 'coverage/fire-loop.wav', gain: 0.209 },
  'fire-end': { file: 'coverage/fire-end.wav', gain: 0.158 },
  'roll-loop': { file: 'coverage/roll-loop.wav', gain: 0.146 },
  'roll-stop': { file: 'coverage/roll-stop.wav', gain: 0.292 },
  'player-impact': { file: 'coverage/player-impact.wav', gain: 0.226 },
  'item-impact': { file: 'coverage/item-impact.wav', gain: 0.359 },
  'rocket-loop': { file: 'coverage/rocket-loop.wav', gain: 0.186 },
  'photon-loop': { file: 'coverage/photon-loop.wav', gain: 0.141 },
  'photon-end': { file: 'coverage/photon-end.wav', gain: 0.122 },
  'scope-in': { file: 'coverage/scope-in.wav', gain: 0.484 },
  'scope-out': { file: 'coverage/scope-out.wav', gain: 0.638 },
  'ambient-loop': { file: 'coverage/ambient-loop.wav', gain: 0.06 },
  'round-start': { file: 'coverage/round-start.wav', gain: 0.226 },
  'round-end': { file: 'coverage/round-end.wav', gain: 0.226 },
  victory: { file: 'coverage/victory.wav', gain: 0.209 },
  defeat: { file: 'coverage/defeat.wav', gain: 0.944 },
  'pickup-grenade': { file: 'coverage/pickup-grenade.wav', gain: 0.556 },
  'rocket-explosion': { file: 'coverage/rocket-explosion.wav', gain: 0.49 },
  'photon-impact': { file: 'coverage/photon-impact.wav', gain: 0.12 },
  'flame-impact': { file: 'coverage/flame-impact.wav', gain: 0.437 },
  'ui-confirm': { file: 'coverage/ui-confirm.wav', gain: 0.14 },
  'ui-error': { file: 'coverage/ui-error.wav', gain: 0.452 },
  'ui-select': { file: 'coverage/ui-select.wav', gain: 0.804 },
  'ui-open': { file: 'coverage/ui-open.wav', gain: 0.148 },
  'ui-close': { file: 'coverage/ui-close.wav', gain: 0.145 },
  connected: { file: 'coverage/connected.wav', gain: 0.279 },
  disconnected: { file: 'coverage/disconnected.wav', gain: 0.211 },

  smg: { file: 'smg-a.wav', gain: 0.716 },
  shotgun: { file: 'shotgun-b.wav', gain: 0.385 },
  dual: { file: 'dual.wav', gain: 0.26 },
  chain: { file: 'chain.wav', gain: 0.676 },
  sniper: { file: 'sniper.wav', gain: 0.407 },
  bazooka: { file: 'bazooka.wav', gain: 0.537 },
  photon: { file: 'photon.wav', gain: 0.275 },
  flamethrower: { file: 'flamethrower.wav', gain: 0.26 },
  minibot: { file: 'minibot.wav', gain: 0.519 },
  death: { file: 'death.wav', gain: 0.26 },
  round: { file: 'round.wav', gain: 0.178 },
  explosion: { file: 'explosion-b.wav', gain: 0.394 },
  hit: { file: 'hit-c.wav', gain: 1 },
  damage: { file: 'damage-a.wav', gain: 0.741 },
  reload: { file: 'reload.wav', gain: 0.741 },
  charge: { file: 'charge.wav', gain: 0.172 },
  overheat: { file: 'overheat.wav', gain: 0.166 },
  knives: { file: 'knives.wav', gain: 0.412 },
  shield: { file: 'shield.wav', gain: 0.174 },
  throw: { file: 'throw.wav', gain: 0.398 },
  bounce: { file: 'bounce.wav', gain: 0.684 },
  'molotov-break': { file: 'molotov-break.wav', gain: 0.221 },
  ricochet: { file: 'ricochet.wav', gain: 0.195 },
  'pickup-health': { file: 'pickup-health.wav', gain: 0.2 },
  'pickup-equipment': { file: 'pickup-equipment.wav', gain: 0.596 },
  'flag-take': { file: 'flag-take.wav', gain: 0.32 },
  'flag-drop': { file: 'flag-drop.wav', gain: 1 },
  'flag-return': { file: 'flag-return.wav', gain: 0.452 },
  'flag-capture': { file: 'flag-capture.wav', gain: 0.543 },
} as const;
export type AudioSample = keyof typeof AUDIO_SAMPLES;

type AudioTake = { file: string; gain: number };
export const AUDIO_VARIANTS: Partial<Record<AudioSample, readonly AudioTake[]>> = {
  damage: [{ file: 'damage-b.wav', gain: 0.944 }],
  ricochet: [
    { file: 'ricochet-2.wav', gain: 0.452 },
    { file: 'ricochet-3.wav', gain: 0.313 },
    { file: 'ricochet-4.wav', gain: 0.135 },
    { file: 'ricochet-5.wav', gain: 0.269 },
  ],
  death: [
    { file: 'death-2.wav', gain: 0.531 },
    { file: 'death-3.wav', gain: 0.269 },
  ],
};
export function sampleTakes(kind: AudioSample): readonly AudioTake[] {
  return [AUDIO_SAMPLES[kind], ...(AUDIO_VARIANTS[kind] ?? [])];
}
export function sampleFiles(kind: AudioSample): readonly string[] {
  return sampleTakes(kind).map((take) => take.file);
}
export const WEAPON_SAMPLES = {
  smg: 'smg',
  shotgun: 'shotgun',
  dual: 'dual',
  chain: 'chain',
  sniper: 'sniper',
  bazooka: 'bazooka',
  photon: 'photon',
  flamethrower: 'flamethrower',
  minibot: 'minibot',
} as const satisfies Record<string, AudioSample>;

export const LOOP_SAMPLES = [
  'fire-loop',
  'roll-loop',
  'rocket-loop',
  'photon-loop',
  'ambient-loop',
] as const;
export type LoopSample = (typeof LOOP_SAMPLES)[number];
