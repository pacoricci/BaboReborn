import { PRIMARY_MODELS } from '../../../frontend/src/presentation/actors/arsenal';
import { EQUIPMENT_NAMES } from '../../../frontend/src/core/equipment';
interface AssetEntry {
  id: string;
  name: string;
  category: string;
  type: 'GLB model' | 'Procedural effect' | 'Procedural surface';
  action: string;
  description: string;
}
const model = (id: string, name: string, category: string, action = 'Inspect'): AssetEntry => ({
  id,
  name,
  category,
  type: 'GLB model',
  action,
  description: 'Shared game model and materials. Art remains provisional.',
});
export const CATALOG: AssetEntry[] = [
  model('babo', 'Babo', 'Character', 'Roll'),
  {
    ...model('weapon-mount', 'Weapon cradle', 'Character'),
    description:
      'Weapon-specific fittings. This view shows the compact SMG clip; inspect each primary overhead for its dedicated harness, support or power pack.',
  },
  ...PRIMARY_MODELS.map((id) =>
    model(
      id,
      EQUIPMENT_NAMES[id as keyof typeof EQUIPMENT_NAMES] ?? id,
      'Primary weapons',
      id === 'shotgun' ? 'Reload' : id === 'photon' ? 'Charge / fire' : 'Fire',
    ),
  ),
  model('knives', 'Popup Knives', 'Secondary equipment', 'Extend / retract'),
  {
    id: 'shield',
    name: 'Shield',
    category: 'Secondary equipment',
    type: 'Procedural effect',
    action: 'Activate / fade',
    description: 'The game’s transparent energy sphere and rim. No GLB is expected.',
  },
  model('minibot', 'Mini Bot', 'Secondary equipment', 'Aim / fire'),
  model('grenade', 'Grenade', 'Throwables', 'Flight / explosion'),
  model('molotov', 'Molotov', 'Throwables', 'Flight / break / fire'),
  model('health', 'Medikit', 'Pickups'),
  model('rocket', 'Rocket', 'Projectiles', 'Flight / explosion'),
  ...(['blue', 'red'] as const).flatMap((team) =>
    [
      ['flag', 'flag'],
      ['base', 'base'],
      ['team', 'team indicator'],
    ].map(([kind, label]): AssetEntry => ({
      id: `${kind}-${team}`,
      name: `${team === 'blue' ? 'Blue' : 'Red'} ${label}`,
      category: 'Teams & objectives',
      type: kind === 'team' ? 'Procedural effect' : 'GLB model',
      action: 'Inspect',
      description:
        kind === 'team'
          ? 'Segmented team marker and contrasting insignia, shown with a Babo. Blue diamond / red twin chevrons.'
          : 'Authored CTF model: folded pennant or recessed capture deck, with matching team insignia. Shared with live matches; static art pose.',
    })),
  ),
  model('wall', 'Wall module', 'Environment'),
  {
    id: 'terrain',
    name: 'Terrain',
    category: 'Environment',
    type: 'Procedural surface',
    action: 'Inspect',
    description: 'Map-sized geometry with the game terrain texture.',
  },
  ...[
    ['flame', 'Persistent fire', 'Burn'],
    ['explosion', 'Explosion', 'Burst / fade'],
    ['tracer', 'Shot trail & impact', 'Fire'],
    ['flash', 'Muzzle flash', 'Fire'],
    ['pickup', 'Weapon pickup & ring', 'Inspect'],
    ['health-bar', 'Health indicator', 'Damage / restore'],
  ].map(([id, name, action]) => ({
    id: id!,
    name: name!,
    action: action!,
    category: 'Effects & indicators',
    type: 'Procedural effect' as const,
    description:
      'Actual game presentation, including any supporting model. No separate effect GLB is expected.',
  })),
];
export const entry = (id: string) => CATALOG.find((item) => item.id === id) ?? CATALOG[0]!;
