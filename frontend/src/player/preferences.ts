import { editNicknameColors, validNicknameColors } from './nickname';
import { onCleanup } from 'solid-js';
import { createStore } from 'solid-js/store';
import { isAppearance } from './appearance';
import type { Appearance } from './appearance';
import type { Catalog } from '../content/types';
import { isPrimary, isSecondary } from '../core/equipment';
import type { PlayerSettings } from './player-preferences';

export const SAVED_STATUS_MS = 2500;

interface PreferencesState {
  settings: PlayerSettings;
  appearance: Appearance;
  unavailableSkin: boolean;
  characterFeedback: string;
  optionsFeedback: string;
}
interface PreferencesPorts {
  saveSettings(value: PlayerSettings): boolean;
  saveAppearance(value: Appearance): boolean;
}
const saveFailure = 'Could not save your changes. Check your browser settings.';
export type PreferencesApplication = ReturnType<typeof createPreferences>;
export function createPreferences(
  initial: PreferencesState,
  catalog: Catalog,
  ports: PreferencesPorts,
) {
  const [state, setState] = createStore(initial);
  const timers: Partial<
    Record<'characterFeedback' | 'optionsFeedback', ReturnType<typeof setTimeout>>
  > = {};
  function feedback(key: 'characterFeedback' | 'optionsFeedback', saved: boolean) {
    clearTimeout(timers[key]);
    setState(key, saved ? 'Saved.' : saveFailure);
    if (saved) timers[key] = setTimeout(() => setState(key, ''), SAVED_STATUS_MS);
  }
  onCleanup(() => Object.values(timers).forEach(clearTimeout));
  function settings(patch: Partial<PlayerSettings>, options = false): void {
    const settings = { ...state.settings, ...patch };
    const saved = ports.saveSettings(settings);
    setState({ settings });
    feedback(options ? 'optionsFeedback' : 'characterFeedback', saved);
  }
  function nickname(raw: string, decoration?: string): string {
    const nickname = raw.trim();
    if (!/^[A-Za-z0-9 _-]{1,20}$/.test(nickname))
      return 'Enter 1–20 letters (A–Z), numbers, spaces, _ or -.';
    if (!validNicknameColors(decoration, nickname)) return 'Choose valid nickname colors.';
    settings({
      nickname,
      ...(decoration !== undefined || state.settings.nicknameColors !== undefined
        ? {
            nicknameColors:
              decoration ??
              editNicknameColors(state.settings.nickname, nickname, state.settings.nicknameColors),
          }
        : {}),
    });
    return '';
  }
  function primary(value: string): void {
    if (isPrimary(value)) settings({ primary: value });
  }
  function secondary(value: string): void {
    if (isSecondary(value)) settings({ secondary: value });
  }
  function appearance(value: Appearance): void {
    if (!isAppearance(value) || !catalog.skins.some((skin) => skin.id === value.template)) return;
    const saved = ports.saveAppearance(value);
    setState({
      appearance: value,
      unavailableSkin: false,
    });
    feedback('characterFeedback', saved);
  }
  return {
    state,
    catalog,
    nickname,
    primary,
    secondary,
    appearance,
    options: (patch: Partial<PlayerSettings>) => settings(patch, true),
  };
}
