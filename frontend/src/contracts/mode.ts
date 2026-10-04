// Mode codes shared by room rules, discovery and the public catalog; names are UI text.
export const MODES = ['dm', 'tdm', 'ctf'] as const;
export type Mode = (typeof MODES)[number];
export const MODE_NAMES: Readonly<Record<Mode, string>> = {
  dm: 'Deathmatch',
  tdm: 'Team Deathmatch',
  ctf: 'Capture the Flag',
};
export function isMode(value: unknown): value is Mode {
  return MODES.includes(value as Mode);
}
