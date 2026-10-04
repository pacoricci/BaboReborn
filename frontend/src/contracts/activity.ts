import type { Primary, Secondary } from '../core/equipment';
export type Team = 'none' | 'blue' | 'red';
export const isTeam = (value: unknown): value is Team =>
  value === 'none' || value === 'blue' || value === 'red';
interface Participant {
  id: number;
  nickname: string;
  nicknameColors?: string | undefined;
  team: Team;
}
export type Activity = {
  occurredAtMs: number;
  id: number;
  tick: number;
  round: number;
  actor: Participant;
} & (
  | { kind: 'kill'; victim: Participant; weapon: Primary | Secondary | 'grenade' | 'molotov' }
  | { kind: 'connected' }
  | { kind: 'disconnected' }
  | { kind: 'flag-take' | 'flag-drop' | 'flag-return' | 'flag-capture' }
);
