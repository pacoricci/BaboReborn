import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseSkin, parseTheme, parseDecal } from '../../src/content/validation';
import type { Catalog } from '../../src/content/types';
import { installContent } from '../../src/content/runtime';
const root = new URL('../../../content/', import.meta.url);
const directories = (kind: string) =>
  readdirSync(new URL(`${kind}/`, root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
export const skins = directories('skins').map((id) =>
  parseSkin(JSON.parse(readFileSync(new URL(`skins/${id}/skin.json`, root), 'utf8'))),
);
export const themes = directories('themes').map((id) =>
  parseTheme(JSON.parse(readFileSync(new URL(`themes/${id}/theme.json`, root), 'utf8'))),
);
export const decals = directories('decals').map((id) =>
  parseDecal(JSON.parse(readFileSync(new URL(`decals/${id}/decal.json`, root), 'utf8'))),
);
const url = (kind: string, id: string, file: string) =>
  `/content/v1/files/${createHash('sha256')
    .update(readFileSync(new URL(`${kind}/${id}/${file}`, root)))
    .digest('hex')}.${file.split('.').at(-1)}`;
export const bundledCatalog: Catalog = {
  schema: 1,
  decals: decals.map((d) => ({ ...d, texture: url('decals', d.id, d.texture) })),
  fileOrigin: '',
  maps: readdirSync(new URL('maps/', root))
    .filter((f) => f.endsWith('.json'))
    .map((file) => {
      const bytes = readFileSync(new URL(`maps/${file}`, root));
      const a = JSON.parse(bytes.toString()) as { id: string; name: string; teams?: unknown };
      return {
        id: a.id,
        name: a.name,
        ctf: Boolean(a.teams),
        file: `/content/v1/files/${createHash('sha256').update(bytes).digest('hex')}.json`,
      };
    }),
  revision: '0'.repeat(64),
  defaultSkin: 'geometric',
  defaultTheme: 'classic',
  skins: skins.map((s) => ({ ...s, mask: url('skins', s.id, s.mask) })),
  themes: themes.map((t) => ({
    ...t,
    floor: url('themes', t.id, t.floor),
    ...(t.earth ? { earth: url('themes', t.id, t.earth) } : {}),
    materials: Object.fromEntries(
      Object.entries(t.materials).map(([id, m]) => [
        id,
        { ...m, wall: url('themes', t.id, m.wall), top: url('themes', t.id, m.top) },
      ]),
    ),
  })),
};
installContent(bundledCatalog);
