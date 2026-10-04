import { defaultOptions } from './game-options';
import type { GameOptions } from './game-options';
import type { Primary, Secondary } from '../core/equipment';

export interface PlayerSettings extends GameOptions {
  nickname: string;
  nicknameColors?: string | undefined;
  primary: Primary;
  secondary: Secondary;
  sound: boolean;
  music: boolean;
  collectDiagnostics: boolean;
}
export const defaultSettings: PlayerSettings = {
  ...defaultOptions,
  nickname: 'Rookie',
  primary: 'smg',
  secondary: 'knives',
  sound: true,
  music: true,
  collectDiagnostics: false,
};
