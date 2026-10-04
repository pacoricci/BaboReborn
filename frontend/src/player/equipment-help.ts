import type { Primary, Secondary } from '../core/equipment';
const primaryHelp: Record<Primary, string> = {
  smg: 'Hold left mouse to fire. Short bursts stay more accurate.',
  shotgun: 'Five pellets per shell. Six shells trigger a full reload.',
  dual: 'Hold left mouse for alternating barrels and stronger recoil.',
  chain: 'Watch heat; release to cool down. Moving slowly improves accuracy.',
  sniper: 'Aim farther from your Babo to scope. SCOPED shots deal extra damage.',
  bazooka:
    'Fire to launch; fire again after 0.25 s to detonate. Holding fire also detonates. Explosions can hurt you.',
  photon: 'Hold fire to charge, then leave a damaging beam. Releasing pauses the charge.',
  flamethrower: 'Continuous fire shortens the flame. Pause briefly to restore its reach.',
};
const secondaryHelp: Record<Secondary, string> = {
  knives: 'Space: strike nearby opponents.',
  shield: 'Space: temporarily reduce incoming damage.',
  minibot: 'Space: place one stationary turret toward your aim for 5 s.',
};
export function equipmentHelp(
  primary: Primary,
  secondary: Secondary,
  fire = 'left mouse',
  useSecondary = 'Space',
): string {
  return `${primaryHelp[primary].replace('left mouse', fire)} ${secondaryHelp[secondary].replace('Space', useSecondary)}`;
}
