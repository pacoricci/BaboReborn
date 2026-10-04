// Browser-free cosmetic metadata; never part of predicted mechanics.
export interface Appearance {
  readonly template: string;
  readonly colors: readonly [string, string, string];
}
export const DEFAULT_APPEARANCE: Appearance = {
  template: 'geometric',
  colors: ['#235cce', '#162c61', '#e8eef5'],
};
export const TARGET_APPEARANCE: Appearance = {
  template: 'bands',
  colors: ['#cb3939', '#651d29', '#f3d8aa'],
};
export function isAppearance(value: unknown): value is Appearance {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<Appearance>;
  return (
    typeof v.template === 'string' &&
    /^[a-z0-9][a-z0-9-]{0,47}$/.test(v.template) &&
    Array.isArray(v.colors) &&
    v.colors.length === 3 &&
    v.colors.every((c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c))
  );
}
