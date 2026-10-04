import { validNicknameColors } from './nickname';
import { parseOptions } from './game-options';
import { isPrimary, isSecondary } from '../core/equipment';
import { defaultSettings } from './player-preferences';
import type { PlayerSettings } from './player-preferences';
export type { PlayerSettings } from './player-preferences';

const SETTINGS_KEY = 'baboreborn.player.global.v1';

export function readSettings(): PlayerSettings {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return { ...defaultSettings };
    const s = raw as Partial<PlayerSettings>;
    return {
      ...parseOptions(s),
      nickname:
        typeof s.nickname === 'string' && /^[A-Za-z0-9 _-]{1,20}$/.test(s.nickname.trim())
          ? s.nickname.trim()
          : defaultSettings.nickname,
      nicknameColors:
        typeof s.nickname === 'string' &&
        /^[A-Za-z0-9 _-]{1,20}$/.test(s.nickname.trim()) &&
        validNicknameColors(s.nicknameColors, s.nickname.trim())
          ? s.nicknameColors
          : undefined,
      primary: isPrimary(s.primary) ? s.primary : 'smg',
      secondary: isSecondary(s.secondary) ? s.secondary : 'knives',
      sound: s.sound !== false,
      music: s.music !== false,
      collectDiagnostics: s.collectDiagnostics === true,
    };
  } catch {
    return { ...defaultSettings };
  }
}
export function saveSettings(settings: PlayerSettings): boolean {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}
