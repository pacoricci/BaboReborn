// Maintained TS/Go replay agreement, not an oracle for original-executable fidelity.
import { createPlayer } from '../../src/core/simulation';
import type { Input, Player } from '../../src/core/simulation';
import { PRIMARIES, SECONDARIES, createEquipment } from '../../src/core/equipment';
import type { Wall } from '../../src/core/geometry';
import { SMG_MUZZLE } from '../../src/gameconfig/tuning';

const idle: Input = { x: 0, y: 0, aim: { x: 30, y: 18 }, fire: false };
const firing: Input = { ...idle, fire: true };
function equipped(
  primary: (typeof PRIMARIES)[number] = 'smg',
  secondary: (typeof SECONDARIES)[number] = 'knives',
): Player {
  return { ...createPlayer({ x: 18, y: 18 }, 0), equipment: createEquipment(primary, secondary) };
}
function ready(
  primary: (typeof PRIMARIES)[number],
  secondary: (typeof SECONDARIES)[number] = 'knives',
): Player {
  return { ...equipped(primary, secondary), cooldown: 0 };
}
interface ReplayCase {
  id: string;
  initial: Player;
  segments: { ticks: number; input: Input }[];
  walls?: Wall[];
}
// Exercise sustained fire, releases and secondary actions across the current arsenal.
const referenceCases = [
  ...PRIMARIES.flatMap((primary) => [
    {
      id: `${primary}-continuous`,
      initial: equipped(primary),
      segments: [{ ticks: 1200, input: { ...idle, x: 1, fire: true } }],
    },
    {
      id: `${primary}-release-and-secondary`,
      initial: equipped(primary, 'minibot'),
      segments: [
        { ticks: 160, input: { ...idle, fire: true } },
        { ticks: 80, input: idle },
        { ticks: 300, input: { ...idle, fire: true, y: -1 } },
        { ticks: 1, input: { ...idle, secondary: true } },
        { ticks: 180, input: { ...idle, fire: true, aim: { x: 18, y: 18 } } },
      ],
    },
  ]),
  ...SECONDARIES.map((secondary) => ({
    id: `secondary-${secondary}`,
    initial: equipped('dual', secondary),
    segments: [{ ticks: 1600, input: { ...idle, secondary: true } }],
  })),
  {
    id: 'shotgun-reload',
    initial: equipped('shotgun'),
    segments: [{ ticks: 1200, input: { ...idle, x: 1, fire: true } }],
  },
  {
    id: 'shield-and-throws',
    initial: equipped('smg', 'shield'),
    segments: [
      { ticks: 121, input: idle },
      { ticks: 1, input: { ...idle, secondary: true, molotov: true } },
      { ticks: 310, input: idle },
      { ticks: 1, input: { ...idle, grenade: true } },
      { ticks: 122, input: idle },
      { ticks: 1, input: { ...idle, grenade: true } },
      { ticks: 180, input: { ...idle, fire: true } },
    ],
  },
  {
    id: 'knives-and-fire',
    initial: equipped(),
    segments: [
      {
        ticks: 600,
        input: { ...idle, x: -1, fire: true, secondary: true, grenade: true, molotov: true },
      },
    ],
  },
];

const transitionCases: ReplayCase[] = [
  {
    id: 'photon-partial-charge-throw-lock',
    initial: ready('photon', 'shield'),
    segments: [
      { ticks: 30, input: firing },
      { ticks: 24, input: idle },
      { ticks: 1, input: { ...idle, secondary: true, grenade: true, molotov: true } },
      { ticks: 300, input: firing },
      { ticks: 240, input: firing },
    ],
  },
  {
    id: 'chain-overheat-release-recovery',
    initial: ready('chain'),
    segments: [
      { ticks: 1200, input: firing },
      { ticks: 300, input: idle },
      { ticks: 120, input: firing },
    ],
  },
  {
    id: 'sniper-scoped-to-unscoped',
    initial: ready('sniper'),
    segments: [
      { ticks: 180, input: idle },
      { ticks: 1, input: firing },
      { ticks: 270, input: { ...idle, aim: { x: 18, y: 18 } } },
      { ticks: 1, input: { ...firing, aim: { x: 18, y: 18 } } },
    ],
  },
  {
    id: 'bazooka-detonation-window',
    initial: ready('bazooka'),
    segments: [
      { ticks: 31, input: firing },
      { ticks: 60, input: idle },
      { ticks: 1, input: firing },
    ],
  },
  {
    id: 'flamethrower-range-reset',
    initial: ready('flamethrower'),
    segments: [
      { ticks: 180, input: firing },
      { ticks: 36, input: idle },
      { ticks: 1, input: firing },
    ],
  },
  {
    id: 'dual-alternating-muzzle-cover',
    initial: ready('dual'),
    walls: [{ x: 20, y: 12, w: 1, h: 12 }],
    segments: [
      { ticks: 120, input: firing },
      { ticks: 180, input: { ...firing, x: 1, y: 1, aim: { x: 20, y: 25 } } },
    ],
  },
  {
    id: 'shotgun-reload-blocks-throws',
    initial: ready('shotgun'),
    segments: [
      { ticks: 516, input: firing },
      { ticks: 120, input: { ...idle, grenade: true, molotov: true } },
      { ticks: 242, input: { ...idle, grenade: true } },
      { ticks: 122, input: { ...idle, molotov: true } },
      { ticks: 180, input: firing },
    ],
  },
];

export const predictionSuite = {
  gridBounds: { x: 0, y: 0, w: 36, h: 36 },
  randomSeed: 7291,
  shotGeometry: {
    muzzleOffset: SMG_MUZZLE.forward,
    muzzleSide: SMG_MUZZLE.right,
    muzzleHeight: SMG_MUZZLE.height,
    maxDistance: 128,
    wallHeight: 0.7,
  },
  cases: ([...referenceCases, ...transitionCases] as ReplayCase[]).map((c) => ({
    ...c,
    dt: 1 / 120,
    walls: c.walls ?? [],
    checkpoints: Array.from({ length: c.segments.reduce((n, s) => n + s.ticks, 0) }, (_, i) => ({
      tick: i + 1,
    })),
  })),
};
