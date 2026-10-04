// Value-only central content contracts; no browser, filesystem or renderer dependencies.
export interface Metadata {
  schema: 1;
  id: string;
  name: string;
  author: string;
}
export interface Skin extends Metadata {
  mask: string;
}
export interface Decal extends Metadata {
  texture: string;
}
interface WallMaterial {
  name: string;
  wall: string;
  top: string;
  tile: number; // [cells]
  emission: number; // [ratio]
  wallHue: number; // [degrees]
}
export interface Theme extends Metadata {
  floor: string;
  floorTile: number; // [cells]
  defaultMaterial: string;
  materials: Record<string, WallMaterial>;
  background: string;
  groundLight: string;
  planFloor: string;
  outdoorWear: boolean;
  earth?: string;
}
export interface MapInfo {
  id: string;
  name: string;
  ctf: boolean;
  file: string;
}
export interface Catalog {
  schema: 1;
  decals: Decal[];
  fileOrigin: string;
  maps: MapInfo[];
  revision: string;
  defaultSkin: string;
  defaultTheme: string;
  skins: Skin[];
  themes: Theme[];
}
export const contentID = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(v);
export function themeByID(catalog: Catalog, id: string): Theme {
  const theme = catalog.themes.find((t) => t.id === id);
  if (!theme) throw new Error(`Unknown theme: ${id}`);
  return theme;
}
export function skinByID(catalog: Catalog, id: string): Skin {
  const skin = catalog.skins.find((t) => t.id === id);
  if (!skin) throw new Error(`Unknown skin: ${id}`);
  return skin;
}
export function decalByID(catalog: Catalog, id: string): Decal {
  const decal = catalog.decals.find((d) => d.id === id);
  if (!decal) throw new Error(`Unknown decal: ${id}`);
  return decal;
}
