import { isAppearance } from './appearance';
import { currentContent } from '../content/runtime';
import { readSettings, saveSettings } from './player-settings';
import { appearanceStorageKey, readAppearance } from '../presentation/ui/appearance-settings';
import { createPreferences } from './preferences';
import type { PreferencesApplication } from './preferences';

export function browserPreferences(): PreferencesApplication {
  const appearance = readAppearance();
  let unavailableSkin = false;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(appearanceStorageKey()) ?? 'null');
    unavailableSkin = isAppearance(saved) && saved.template !== appearance.template;
  } catch {
    /* Missing preferences use the installed defaults. */
  }
  return createPreferences(
    {
      settings: readSettings(),
      appearance,
      unavailableSkin,
      characterFeedback: '',
      optionsFeedback: '',
    },
    currentContent(),
    {
      saveSettings,
      saveAppearance(value) {
        try {
          localStorage.setItem(appearanceStorageKey(), JSON.stringify(value));
          return true;
        } catch {
          return false;
        }
      },
    },
  );
}
