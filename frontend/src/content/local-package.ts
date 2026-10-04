import type { Skin, Theme } from './types';
import { parseSkin, parseTheme } from './validation';
export interface LocalPackage {
  skin?: Skin;
  theme?: Theme;
  dispose(): void;
}
// File input grants access only to the selected directory. Nothing is uploaded.
export async function openPackage(
  files: readonly File[],
  kind: 'skin' | 'theme',
): Promise<LocalPackage> {
  if (files.reduce((sum, file) => sum + file.size, 0) > 16 * 1024 * 1024)
    throw new Error('Package exceeds 16 MiB');
  if (files.filter((file) => file.name === `${kind}.json`).length !== 1)
    throw new Error(`Select exactly one ${kind} package directory`);
  const manifest = files.find((f) => f.name === `${kind}.json`);
  if (!manifest) throw new Error(`Missing ${kind}.json`);
  if (manifest.size > 65536) throw new Error('Manifest exceeds 64 KiB');
  const source: unknown = JSON.parse(await manifest.text());
  const definition = kind === 'skin' ? parseSkin(source) : parseTheme(source);
  const root = manifest.webkitRelativePath.slice(0, -manifest.name.length);
  const entries = new Map(
    files.map((f) => [(f.webkitRelativePath || f.name).slice(root.length), f]),
  );
  let total = 0;
  const urls = new Map<string, string>();
  const dispose = () => {
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
  };
  const image = async (path: string): Promise<string> => {
    const cached = urls.get(path);
    if (cached) return cached;
    const file = entries.get(path);
    if (!file) throw new Error(`Missing image: ${path}`);
    total += file.size;
    if (file.size > 4 * 1024 * 1024 || total > 16 * 1024 * 1024)
      throw new Error('Image/package size limit exceeded');
    const signature = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const valid = path.endsWith('.webp')
      ? new TextDecoder().decode(signature.slice(0, 4)) === 'RIFF' &&
        new TextDecoder().decode(signature.slice(8, 12)) === 'WEBP'
      : signature.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10';
    if (!valid) throw new Error(`Invalid image signature: ${path}`);
    const bitmap = await createImageBitmap(file);
    try {
      if (
        bitmap.width > 1024 ||
        bitmap.height > 1024 ||
        (kind === 'skin' && (bitmap.width !== 512 || bitmap.height !== 256))
      )
        throw new Error(`Invalid dimensions: ${path}`);
    } finally {
      bitmap.close();
    }
    const url = URL.createObjectURL(file);
    urls.set(path, url);
    return url;
  };
  try {
    if (kind === 'skin') {
      const s = definition as Skin;
      return { skin: { ...s, mask: await image(s.mask) }, dispose };
    }
    const t = definition as Theme;
    const theme = { ...t, floor: await image(t.floor), materials: { ...t.materials } };
    if (t.earth) theme.earth = await image(t.earth);
    for (const [id, m] of Object.entries(t.materials))
      theme.materials[id] = { ...m, wall: await image(m.wall), top: await image(m.top) };
    return { theme, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
