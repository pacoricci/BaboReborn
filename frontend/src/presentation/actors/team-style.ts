// Shared art identity, independent of team assignment and objective rules.
export const TEAM_COLORS = { blue: '#55aaff', red: '#ff665e' } as const;
export const TEAM_SKIN_COLORS = {
  blue: ['#367cdb', '#2869c4', '#4a8de8'],
  red: ['#db4545', '#c73535', '#e85959'],
} as const;
export type TeamStyle = keyof typeof TEAM_COLORS;
type Point = readonly [number, number];
export function teamSymbol(team: TeamStyle): readonly (readonly Point[])[] {
  // Hollow diamond versus twin chevrons remain distinct without color.
  return team === 'blue'
    ? [
        [
          [0, -1],
          [1, 0],
          [0.55, 0],
          [0, -0.55],
        ],
        [
          [1, 0],
          [0, 1],
          [0, 0.55],
          [0.55, 0],
        ],
        [
          [0, 1],
          [-1, 0],
          [-0.55, 0],
          [0, 0.55],
        ],
        [
          [-1, 0],
          [0, -1],
          [0, -0.55],
          [-0.55, 0],
        ],
      ]
    : [-0.45, 0.45].flatMap((offset) => [
        [
          [-0.9, offset + 0.35],
          [0, offset - 0.3],
          [0, offset + 0.05],
          [-0.9, offset + 0.7],
        ],
        [
          [0, offset - 0.3],
          [0.9, offset + 0.35],
          [0.9, offset + 0.7],
          [0, offset + 0.05],
        ],
      ]);
}
