import { currentContent } from '../../content/runtime';
import { DEFAULT_APPEARANCE, isAppearance } from '../../player/appearance';

export function appearanceStorageKey(): string {
  return 'baboreborn.appearance.v1:portal';
}
export function readAppearance() {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(appearanceStorageKey()) ?? 'null');
    if (isAppearance(saved))
      return currentContent().skins.some((s) => s.id === saved.template)
        ? saved
        : { ...saved, template: currentContent().defaultSkin };
  } catch {
    // Cosmetics remain available when browser storage is blocked.
  }
  return { ...DEFAULT_APPEARANCE, template: currentContent().defaultSkin };
}

export function unavailableAppearance(): boolean {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(appearanceStorageKey()) ?? 'null');
    return isAppearance(raw) && !currentContent().skins.some((s) => s.id === raw.template);
  } catch {
    return false;
  }
}
