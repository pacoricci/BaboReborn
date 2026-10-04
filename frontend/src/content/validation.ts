import { contentID } from './types';
import type { Catalog, Metadata, Skin, Theme, MapInfo, Decal } from './types';
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const color = (v: unknown) => typeof v === 'string' && /^#[a-fA-F0-9]{6}$/.test(v);
const metadataKeys = ['schema', 'id', 'name', 'author'];
function keys(v: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(v).some((k) => !allowed.includes(k))) throw new Error('Unknown manifest field');
}
function metadata(v: unknown): asserts v is Metadata & Record<string, unknown> {
  if (
    !record(v) ||
    v.schema !== 1 ||
    !contentID(v.id) ||
    !['name', 'author'].every(
      (k) => typeof v[k] === 'string' && v[k].trim().length > 0 && [...v[k]].length <= 512,
    )
  )
    throw new Error('Invalid content metadata');
}
function imagePath(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    /\.(png|webp)$/.test(v) &&
    !/[\\:%?#]/.test(v) &&
    v.split('/').every((p) => p !== '' && p !== '.' && p !== '..')
  );
}
const imageURL = (v: unknown): v is string =>
  typeof v === 'string' && /^\/content\/v1\/files\/[a-f0-9]{64}\.(png|webp)$/.test(v);
export function parseSkin(v: unknown, resolved = false): Skin {
  metadata(v);
  keys(v, [...metadataKeys, 'mask']);
  if (!(resolved ? imageURL : imagePath)(v.mask) || !v.mask.endsWith('.png'))
    throw new Error('Invalid skin mask');
  return v as unknown as Skin;
}
export function parseDecal(v: unknown, resolved = false): Decal {
  metadata(v);
  keys(v, [...metadataKeys, 'texture']);
  if (!(resolved ? imageURL : imagePath)(v.texture)) throw new Error('Invalid decal texture');
  return v as unknown as Decal;
}
export function parseTheme(v: unknown, resolved = false): Theme {
  metadata(v);
  keys(v, [
    ...metadataKeys,
    'floor',
    'floorTile',
    'defaultMaterial',
    'materials',
    'background',
    'groundLight',
    'planFloor',
    'outdoorWear',
    'earth',
  ]);
  const image = resolved ? imageURL : imagePath;
  if (
    !image(v.floor) ||
    !finite(v.floorTile, Number.MIN_VALUE, 64) ||
    ![v.background, v.groundLight, v.planFloor].every(color) ||
    typeof v.outdoorWear !== 'boolean' ||
    (v.earth !== undefined && !image(v.earth)) ||
    (v.outdoorWear && !image(v.earth)) ||
    !record(v.materials) ||
    Object.keys(v.materials).length < 1 ||
    Object.keys(v.materials).length > 8 ||
    !contentID(v.defaultMaterial) ||
    !Object.hasOwn(v.materials, v.defaultMaterial)
  )
    throw new Error('Invalid theme surfaces or defaults');
  for (const [id, m] of Object.entries(v.materials)) {
    if (!contentID(id) || !record(m)) throw new Error('Invalid material id');
    keys(m, ['name', 'wall', 'top', 'tile', 'emission', 'wallHue']);
    if (
      typeof m.name !== 'string' ||
      !m.name.trim() ||
      !image(m.wall) ||
      !image(m.top) ||
      !finite(m.tile, Number.MIN_VALUE, 64) ||
      !finite(m.emission, 0, 1) ||
      !finite(m.wallHue, 0, 360)
    )
      throw new Error(`Invalid material: ${id}`);
  }
  return v as unknown as Theme;
}
export function parseCatalog(v: unknown): Catalog {
  if (
    !record(v) ||
    v.schema !== 1 ||
    !Array.isArray(v.decals) ||
    typeof v.fileOrigin !== 'string' ||
    !Array.isArray(v.maps) ||
    v.maps.length === 0 ||
    typeof v.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.revision) ||
    !Array.isArray(v.skins) ||
    !Array.isArray(v.themes)
  )
    throw new Error('Invalid content catalog');
  if (v.fileOrigin !== '') {
    const origin = new URL(v.fileOrigin);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
    if (
      origin.origin !== v.fileOrigin ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local))
    )
      throw new Error('Invalid content distribution origin');
  }
  const maps = (v.maps as unknown[]).map((m): MapInfo => {
    if (
      !record(m) ||
      !contentID(m.id) ||
      typeof m.name !== 'string' ||
      !m.name.trim() ||
      [...m.name].length > 80 ||
      typeof m.ctf !== 'boolean' ||
      typeof m.file !== 'string' ||
      !/^\/content\/v1\/files\/[a-f0-9]{64}\.json$/.test(m.file)
    )
      throw new Error('Invalid central map reference');
    keys(m, ['id', 'name', 'ctf', 'file']);
    return m as unknown as MapInfo;
  });
  const skins = v.skins.map((s) => parseSkin(s, true)),
    themes = v.themes.map((t) => parseTheme(t, true)),
    decals = v.decals.map((d) => parseDecal(d, true));
  if (
    new Set(maps.map((m) => m.id)).size !== maps.length ||
    new Set(skins.map((s) => s.id)).size !== skins.length ||
    new Set(themes.map((t) => t.id)).size !== themes.length ||
    new Set(decals.map((d) => d.id)).size !== decals.length ||
    !skins.some((s) => s.id === v.defaultSkin) ||
    !themes.some((t) => t.id === v.defaultTheme)
  )
    throw new Error('Invalid content catalog defaults or duplicate IDs');
  return { ...v, skins, themes, maps, decals } as unknown as Catalog;
}
