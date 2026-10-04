import type { MapWall, ArenaMap } from '../../maps/types';
import { isArenaMap } from '../../maps/validation';
import type { Vec2 } from '../../core/geometry';
import { MOVEMENT } from '../../gameconfig/tuning';

export type Tool = 'material' | 'wall' | 'floor' | 'spawn' | 'erase' | 'decal';
export type Symmetry = 'none' | 'horizontal' | 'vertical' | 'both';
export const MAX_MAP_BYTES = 1 << 20;

export function newMap(width = 32, height = 32): ArenaMap {
  checkSize(width, height);
  return {
    schema: 1,
    theme: 'classic',
    id: 'my-arena',
    name: 'My arena',
    author: 'Map author',
    width,
    height,
    walls: perimeter(width, height),
    spawns: [
      { x: 2.5, y: 2.5 },
      { x: width - 2.5, y: height - 2.5 },
    ],
  };
}
function checkSize(width: number, height: number): void {
  if (![width, height].every((n) => Number.isInteger(n) && n >= 8 && n <= 128))
    throw new Error('Width and height must be whole numbers from 8 to 128.');
}
function perimeter(width: number, height: number): MapWall[] {
  return [
    { x: 0, y: 0, w: width, h: 1, height: 3 },
    { x: 0, y: height - 1, w: width, h: 1, height: 3 },
    { x: 0, y: 1, w: 1, h: height - 2, height: 3 },
    { x: width - 1, y: 1, w: 1, h: height - 2, height: 3 },
  ];
}
const contains = (w: MapWall, x: number, y: number) =>
  x >= w.x && x < w.x + w.w && y >= w.y && y < w.y + w.h;

// Split only touched rectangles. Untouched imported heights and overlaps stay exact.
function removeCell(walls: readonly MapWall[], x: number, y: number): MapWall[] {
  return walls.flatMap((w) => {
    if (!contains(w, x, y)) return [w];
    return [
      { ...w, h: y - w.y },
      { ...w, y: y + 1, h: w.y + w.h - y - 1 },
      { ...w, y, h: 1, w: x - w.x },
      { ...w, x: x + 1, y, h: 1, w: w.x + w.w - x - 1 },
    ].filter((part) => part.w > 0 && part.h > 0);
  });
}

export function mirrorCells(map: ArenaMap, point: Vec2, symmetry: Symmetry): Vec2[] {
  const xs = [point.x],
    ys = [point.y];
  if (symmetry === 'horizontal' || symmetry === 'both') xs.push(map.width - 1 - point.x);
  if (symmetry === 'vertical' || symmetry === 'both') ys.push(map.height - 1 - point.y);
  return [...new Set(xs)].flatMap((x) => [...new Set(ys)].map((y) => ({ x, y })));
}

export function paint(
  map: ArenaMap,
  point: Vec2,
  tool: Tool,
  height: number,
  symmetry: Symmetry,
  material?: string,
): ArenaMap {
  if (!Number.isInteger(height) || height < 1 || height > 5)
    throw new Error('Choose wall height 1–5.');
  let walls = [...map.walls],
    spawns = [...map.spawns];
  for (const { x, y } of mirrorCells(map, point, symmetry)) {
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      y < 0 ||
      x >= map.width ||
      y >= map.height
    )
      continue;
    if (tool === 'material') {
      // Imported walls may overlap: repaint each layer without removing projectile cover.
      walls = walls.flatMap((wall) =>
        contains(wall, x, y)
          ? [
              ...removeCell([wall], x, y),
              { ...wall, x, y, w: 1, h: 1, ...(material ? { material } : {}) },
            ]
          : [wall],
      );
    }
    if (tool === 'wall' || tool === 'floor' || tool === 'erase') {
      walls = removeCell(walls, x, y);
      if (tool === 'wall')
        walls.push({ x, y, w: 1, h: 1, height, ...(material ? { material } : {}) });
    }
    if (tool === 'erase')
      spawns = spawns.filter((p) => Math.floor(p.x) !== x || Math.floor(p.y) !== y);
    if (tool === 'spawn' && !spawns.some((p) => Math.floor(p.x) === x && Math.floor(p.y) === y))
      spawns.push({ x: x + 0.5, y: y + 0.5 });
  }
  return { ...map, walls, spawns };
}

// Join adjacent, equally high rectangles without rasterizing imported geometry.
export function compactWalls(map: ArenaMap): ArenaMap {
  let walls = [...map.walls];
  for (const horizontal of [true, false]) {
    const groups = new Map<string, MapWall[]>();
    for (const w of walls) {
      const key = horizontal
        ? `${w.y}/${w.h}/${w.height}/${w.material ?? ''}`
        : `${w.x}/${w.w}/${w.height}/${w.material ?? ''}`;
      const group = groups.get(key) ?? [];
      group.push(w);
      groups.set(key, group);
    }
    walls = [];
    for (const group of groups.values()) {
      group.sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
      for (const w of group) {
        const previous = walls.at(-1);
        if (
          previous &&
          (horizontal
            ? previous.y === w.y && previous.h === w.h && previous.x + previous.w === w.x
            : previous.x === w.x && previous.w === w.w && previous.y + previous.h === w.y) &&
          previous.height === w.height &&
          previous.material === w.material
        )
          walls[walls.length - 1] = horizontal
            ? { ...previous, w: previous.w + w.w }
            : { ...previous, h: previous.h + w.h };
        else walls.push(w);
      }
    }
  }
  return { ...map, walls };
}

export function resizeMap(map: ArenaMap, width: number, height: number): ArenaMap {
  checkSize(width, height);
  if (width === map.width && height === map.height) return map;
  // The old outer ring is replaced; content keeps its bottom-left coordinates.
  const walls = map.walls.flatMap((w) => {
    const x = Math.max(1, w.x),
      y = Math.max(1, w.y);
    const right = Math.min(map.width - 1, width - 1, w.x + w.w);
    const top = Math.min(map.height - 1, height - 1, w.y + w.h);
    return right > x && top > y ? [{ ...w, x, y, w: right - x, h: top - y }] : [];
  });
  // Retain spawns even when cropped: validation surfaces them instead of silently deleting them.
  return { ...map, width, height, walls: [...perimeter(width, height), ...walls] };
}

export function strokeCells(from: Vec2, to: Vec2): Vec2[] {
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  if (!steps) return [to];
  return Array.from({ length: steps + 1 }, (_, i) => ({
    x: Math.round(from.x + ((to.x - from.x) * i) / steps),
    y: Math.round(from.y + ((to.y - from.y) * i) / steps),
  }));
}

export interface MapReport {
  errors: string[];
  warnings: string[];
  unreachable: Vec2[];
  regions: number;
}
export function inspectMap(map: ArenaMap): MapReport {
  const errors: string[] = [],
    warnings: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(map.id))
    errors.push(
      'ID: use 1–48 lowercase letters, numbers or hyphens; start with a letter or number.',
    );
  if (![map.name, map.author].every((s) => s.trim() && [...s].length <= 80))
    errors.push('Name and author need 1–80 characters.');
  if (map.spawns.length < 1 || map.spawns.length > 64)
    errors.push('Place between 1 and 64 spawn points.');
  const margin = MOVEMENT.radius + MOVEMENT.clearance;
  map.spawns.forEach((p, i) => {
    if (
      p.x < 1 + margin ||
      p.y < 1 + margin ||
      p.x > map.width - 1 - margin ||
      p.y > map.height - 1 - margin ||
      map.walls.some(
        (w) =>
          p.x > w.x - margin &&
          p.x < w.x + w.w + margin &&
          p.y > w.y - margin &&
          p.y < w.y + w.h + margin,
      )
    )
      errors.push(`Spawn ${i + 1} is blocked or outside the playable interior.`);
  });
  if (!isArenaMap(map) && !errors.length)
    errors.push(
      'Map does not meet its format, geometry or decal limits. Check decal bounds after resizing.',
    );
  const occupied = new Uint8Array(map.width * map.height);
  for (const w of map.walls)
    for (let y = w.y; y < w.y + w.h; y++)
      occupied.fill(1, y * map.width + w.x, y * map.width + w.x + w.w);
  let openEdge = false;
  for (let x = 0; x < map.width; x++)
    if (!occupied[x] || !occupied[(map.height - 1) * map.width + x]) openEdge = true;
  for (let y = 0; y < map.height; y++)
    if (!occupied[y * map.width] || !occupied[y * map.width + map.width - 1]) openEdge = true;
  if (openEdge) warnings.push('The perimeter is open. Add boundary walls to contain projectiles.');
  const labels = new Int32Array(occupied.length);
  let regions = 0;
  for (let y = 1; y < map.height - 1; y++)
    for (let x = 1; x < map.width - 1; x++) {
      const index = y * map.width + x;
      if (occupied[index] || labels[index]) continue;
      const queue = [index];
      labels[index] = ++regions;
      for (let head = 0; head < queue.length; head++) {
        const at = queue[head]!,
          px = at % map.width,
          py = Math.floor(at / map.width);
        for (const p of [
          { x: px - 1, y: py },
          { x: px + 1, y: py },
          { x: px, y: py - 1 },
          { x: px, y: py + 1 },
        ]) {
          const next = p.y * map.width + p.x;
          if (
            p.x < 1 ||
            p.y < 1 ||
            p.x >= map.width - 1 ||
            p.y >= map.height - 1 ||
            occupied[next] ||
            labels[next]
          )
            continue;
          labels[next] = regions;
          queue.push(next);
        }
      }
    }
  const first = map.spawns[0];
  const origin =
    first && first.x >= 0 && first.x < map.width && first.y >= 0 && first.y < map.height
      ? labels[Math.floor(first.y) * map.width + Math.floor(first.x)]
      : 0;
  const unreachable: Vec2[] = [];
  if (origin)
    for (let i = 0; i < labels.length; i++)
      if (labels[i] && labels[i] !== origin)
        unreachable.push({ x: i % map.width, y: Math.floor(i / map.width) });
  if (regions > 1)
    warnings.push(
      `${regions} separate floor regions. Shaded cells cannot be reached from spawn 1.`,
    );
  if (map.spawns.length === 1)
    warnings.push('Only one spawn: add alternatives before multiplayer testing.');
  return { errors, warnings, unreachable, regions };
}

function keysOnly(value: object, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
export function parseMap(source: string): ArenaMap {
  let bytes = 0;
  for (const char of source) {
    const n = char.codePointAt(0)!;
    bytes += n < 128 ? 1 : n < 2048 ? 2 : n < 65536 ? 3 : 4;
  }
  if (bytes > MAX_MAP_BYTES) throw new Error('Map files must be no larger than 1 MiB.');
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('This file is not valid JSON.');
  }
  if (!isArenaMap(value))
    throw new Error(
      'Invalid map format. Check metadata, dimensions, walls, decals and spawn clearance.',
    );
  if (value.teams)
    throw new Error(
      'This editor supports Deathmatch maps. Team maps are preserved by refusing to open them.',
    );
  if (
    !keysOnly(value, [
      'schema',
      'id',
      'name',
      'author',
      'theme',
      'width',
      'height',
      'walls',
      'spawns',
      'decals',
    ]) ||
    !value.walls.every((w) => keysOnly(w, ['x', 'y', 'w', 'h', 'height', 'material'])) ||
    !value.spawns.every((p) => keysOnly(p, ['x', 'y']))
  )
    throw new Error('Unknown map fields. Use the Deathmatch map format.');
  return value;
}
export function exportMap(map: ArenaMap): string {
  const report = inspectMap(map);
  if (report.errors.length) throw new Error(report.errors.join(' '));
  const source = JSON.stringify(map, null, 2) + '\n';
  parseMap(source);
  return source;
}

export class EditorHistory {
  private past: ArenaMap[] = [];
  private future: ArenaMap[] = [];
  private checkpoint: ArenaMap | null = null;
  constructor(public current: ArenaMap) {}
  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  begin(): void {
    this.checkpoint ??= this.current;
  }
  change(map: ArenaMap): void {
    this.begin();
    this.current = map;
  }
  finish(): void {
    if (!this.checkpoint) return;
    this.current = compactWalls(this.current);
    if (JSON.stringify(compactWalls(this.checkpoint)) !== JSON.stringify(this.current)) {
      this.past.push(this.checkpoint);
      if (this.past.length > 64) this.past.shift();
      this.future = [];
    } else this.current = this.checkpoint;
    this.checkpoint = null;
  }
  undo(): void {
    this.finish();
    const previous = this.past.pop();
    if (previous) {
      this.future.push(this.current);
      this.current = previous;
    }
  }
  redo(): void {
    this.finish();
    const next = this.future.pop();
    if (next) {
      this.past.push(this.current);
      this.current = next;
    }
  }
}
