export const actionLabels = {
  up: 'Move forward',
  down: 'Move backward',
  left: 'Move left',
  right: 'Move right',
  fire: 'Fire / respawn',
  secondary: 'Use secondary',
  grenade: 'Grenade',
  molotov: 'Molotov',
  pickup: 'Swap nearby weapon',
  scores: 'Scoreboard',
} as const;
export type Action = keyof typeof actionLabels;
export type Bindings = Record<Action, string>;
export const defaultBindings: Bindings = {
  up: 'KeyW',
  down: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  fire: 'Mouse0',
  secondary: 'Space',
  grenade: 'Mouse2',
  molotov: 'Mouse1',
  pickup: 'KeyF',
  scores: 'Tab',
};
export interface GameOptions {
  volume: number;
  musicVolume: number;
  quality: 'low' | 'medium' | 'high';
  fps: number;
  crosshairSize: number;
  crosshairColor: string;
  reducedEffects: boolean;
  bindings: Bindings;
}
export const defaultOptions: GameOptions = {
  volume: 100,
  musicVolume: 18,
  quality: 'high',
  fps: 0,
  crosshairSize: 17,
  crosshairColor: '#f4efe5',
  reducedEffects: false,
  bindings: defaultBindings,
};
export function bindingLabel(code: string): string {
  return (
    (
      {
        Mouse0: 'Left mouse',
        Mouse1: 'Middle mouse',
        Mouse2: 'Right mouse',
        Space: 'Space',
      } as Record<string, string>
    )[code] ?? code.replace(/^Key|^Digit/, '')
  );
}
export function validBinding(code: string): boolean {
  return (
    /^(Key[A-Z]|Digit[0-9]|Space|Tab|Mouse[012])$/.test(code) &&
    !['KeyG', 'KeyH', 'KeyL', 'KeyM'].includes(code)
  );
}
export function parseOptions(raw: Partial<GameOptions>): GameOptions {
  const number = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.max(min, Math.min(max, value))
      : fallback;
  const bindings = raw.bindings;
  const valid =
    bindings &&
    Object.keys(defaultBindings).every((key) => validBinding(bindings[key as Action])) &&
    new Set(Object.keys(defaultBindings).map((key) => bindings[key as Action])).size ===
      Object.keys(defaultBindings).length;
  return {
    volume: number(raw.volume, 100, 0, 100),
    musicVolume: number(raw.musicVolume, defaultOptions.musicVolume, 0, 100),
    quality: raw.quality === 'low' || raw.quality === 'medium' ? raw.quality : 'high',
    fps: [0, 30, 60, 120, 144].includes(raw.fps as number) ? raw.fps! : 0,
    crosshairSize: number(raw.crosshairSize, 17, 10, 36),
    crosshairColor:
      typeof raw.crosshairColor === 'string' && /^#[0-9a-f]{6}$/i.test(raw.crosshairColor)
        ? raw.crosshairColor
        : '#f4efe5',
    reducedEffects: raw.reducedEffects === true,
    bindings: { ...(valid ? bindings : defaultBindings) },
  };
}
