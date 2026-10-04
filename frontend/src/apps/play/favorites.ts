import { parseRoomReference } from '../../navigation/room-reference';

export const FAVORITES_KEY = 'baboreborn.room-favorites.v1';

// Favorites mark live rows; room metadata is owned exclusively by the catalog.
export function parseFavorites(raw: string | null): string[] {
  if (!raw) return [];
  const refs: unknown = JSON.parse(raw);
  if (!Array.isArray(refs)) throw new Error('Invalid room favorites.');
  for (const ref of refs) {
    if (typeof ref !== 'string') throw new Error('Invalid room favorite.');
    parseRoomReference(ref);
  }
  return [...new Set(refs as string[])];
}

export function toggleFavorite(refs: readonly string[], ref: string): string[] {
  parseRoomReference(ref);
  return refs.includes(ref) ? refs.filter((value) => value !== ref) : [...refs, ref];
}
