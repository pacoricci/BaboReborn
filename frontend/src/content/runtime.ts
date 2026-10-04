import type { Catalog, MapInfo } from './types';
import { parseCatalog } from './validation';
let catalog: Catalog | undefined;
let contentOrigin = '';
const CONTENT_TIMEOUT_MS = 8000;
// Composition roots initialize once before selectors, previews or connections.
export function installContent(value: Catalog, origin = ''): void {
  catalog = value;
  contentOrigin = value.fileOrigin || origin;
}
export function currentContent(): Catalog {
  if (!catalog) throw new Error('Content catalog has not loaded');
  return catalog;
}
async function loadContent(origin: string): Promise<Catalog> {
  const response = await fetch(new URL('/content/v1/catalog', origin), {
    cache: 'no-cache',
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(CONTENT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Content catalog unavailable: HTTP ${response.status}`);
  const value = parseCatalog(await response.json());
  installContent(value, origin);
  return value;
}
export async function startWithContent(
  start: () => void | Promise<void>,
  origin = location.origin,
): Promise<void> {
  try {
    await loadContent(origin);
    await start();
    document.getElementById('content-status')?.remove();
  } catch (error) {
    const message = document.getElementById('content-status') ?? document.createElement('p');
    message.setAttribute('role', 'alert');
    message.textContent = `Unable to load game content. ${error instanceof Error ? error.message : String(error)} Reload to retry.`;
    if (!message.isConnected) document.body.prepend(message);
  }
}

// Keep wire paths relative and validate them before resolving at the rendering boundary.
export function contentURL(path: string): string {
  // Network catalogs reject blob URLs; only validated local file previews create them.
  if (path.startsWith('blob:')) return path;
  if (!/^\/content\/v1\/files\/[a-f0-9]{64}\.(png|webp|json)$/.test(path))
    throw new Error('Invalid content resource');
  return contentOrigin ? new URL(path, contentOrigin).href : path;
}

// Maps use immutable URLs and are checked before the editor consumes their geometry.
export async function loadMap(info: MapInfo) {
  const response = await fetch(contentURL(info.file), {
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(CONTENT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Map ${info.name} unavailable: HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 1 << 20) throw new Error('Map exceeds 1 MiB');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (n) =>
    n.toString(16).padStart(2, '0'),
  ).join('');
  if (info.file !== `/content/v1/files/${hash}.json`) throw new Error('Map content mismatch');
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const { isArenaMap } = await import('../maps/validation');
  if (
    !isArenaMap(value) ||
    value.id !== info.id ||
    value.name !== info.name ||
    Boolean(value.teams) !== info.ctf
  )
    throw new Error('Invalid central map');
  return value;
}
