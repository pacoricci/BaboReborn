// Portions adapted from BaboViolent 2, src/Game/MapRender.cpp.
// Copyright 2012 bitHeads inc.
// SPDX-License-Identifier: GPL-3.0-or-later
// Adapted for BaboReborn; see CREDITS.md and
// frontend/public/licenses/BaboViolent2.txt for provenance and the original notice.

import { clamp } from './geometry';
import type { MovingBody, Vec2, Wall } from './geometry';
import { MOVEMENT } from '../gameconfig/tuning';

export type GridObserver = (before: MovingBody, after: MovingBody) => void;

// Mirrors the authority's contact response, including coincident centers and wall clearance.
export function resolveContact(
  p: MovingBody,
  other: Vec2,
  grid: CollisionGrid,
  direction: number,
  observe?: GridObserver,
): void {
  let dx = other.x - p.x;
  let dy = other.y - p.y;
  let distance = Math.hypot(dx, dy);
  if (distance > 2 * MOVEMENT.radius) return;
  const oldX = p.x;
  const oldY = p.y;
  if (distance < 1e-12) {
    dx = direction;
    dy = 0;
    distance = 1;
  }
  p.x = other.x - (dx / distance) * (2 * MOVEMENT.radius + MOVEMENT.contactGap);
  p.y = other.y - (dy / distance) * (2 * MOVEMENT.radius + MOVEMENT.contactGap);
  p.vx *= -MOVEMENT.bounce;
  p.vy *= -MOVEMENT.bounce;
  resolveGrid(p, oldX, oldY, grid, MOVEMENT.radius, MOVEMENT.bounce, MOVEMENT.clearance, observe);
}

// Integer bounds and row-major occupancy. Consumers borrow the data read-only.
export interface CollisionGrid extends Wall {
  readonly cells: ArrayLike<number>;
}

// Build at world creation, not at each simulation tick. A rectangle is a union
// of whole cells; fractional shot/render geometry must not be silently rasterized.
export function createCollisionGrid(bounds: Wall, walls: readonly Wall[]): CollisionGrid {
  if (
    ![bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isSafeInteger) ||
    bounds.w < 3 ||
    bounds.h < 3
  ) {
    throw new Error('Collision grid needs integer bounds at least 3 by 3');
  }
  const cells = new Uint8Array(bounds.w * bounds.h);
  for (const wall of walls) {
    if (
      ![wall.x, wall.y, wall.w, wall.h].every(Number.isSafeInteger) ||
      wall.w <= 0 ||
      wall.h <= 0 ||
      wall.x < bounds.x ||
      wall.y < bounds.y ||
      wall.x + wall.w > bounds.x + bounds.w ||
      wall.y + wall.h > bounds.y + bounds.h
    ) {
      throw new Error('Collision walls must contain whole cells inside the grid');
    }
    for (let y = wall.y - bounds.y; y < wall.y - bounds.y + wall.h; y++) {
      cells.fill(1, y * bounds.w + wall.x - bounds.x, y * bounds.w + wall.x - bounds.x + wall.w);
    }
  }
  return { ...bounds, cells };
}

function solid(grid: CollisionGrid, x: number, y: number): boolean {
  return x < 0 || y < 0 || x >= grid.w || y >= grid.h || grid.cells[y * grid.w + x] !== 0;
}

const NEIGHBORS = [0, -1, 1] as const;

// Source-derived grid response: Y then X, using the old transverse coordinate.
// The final cardinal clip is distinct from the velocity-dependent bounce.
// Previous position is passed as scalars to avoid allocating a per-tick copy.
export function resolveGrid(
  p: MovingBody,
  previousX: number,
  previousY: number,
  grid: CollisionGrid,
  radius: number,
  bounce: number,
  clearance: number,
  observe?: GridObserver,
): void {
  const before = observe ? { x: p.x, y: p.y, vx: p.vx, vy: p.vy } : undefined;
  applyGrid(p, previousX, previousY, grid, radius, bounce, clearance);
  if (before && (p.x !== before.x || p.y !== before.y || p.vx !== before.vx || p.vy !== before.vy))
    observe!(before, { x: p.x, y: p.y, vx: p.vx, vy: p.vy });
}

function applyGrid(
  p: MovingBody,
  previousX: number,
  previousY: number,
  grid: CollisionGrid,
  radius: number,
  bounce: number,
  clearance: number,
): void {
  const column = clamp(Math.trunc(p.x - grid.x), 1, grid.w - 2);
  const row = clamp(Math.trunc(p.y - grid.y), 1, grid.h - 2);
  const margin = radius + clearance;
  for (let axis = 0; axis < 2; axis++) {
    const vertical = axis === 0;
    const direction = Math.sign(vertical ? p.vy : p.vx);
    if (!direction) continue;
    const previousAcross = vertical ? previousX : previousY;
    for (const offset of NEIGHBORS) {
      const x = column + (vertical ? offset : direction);
      const y = row + (vertical ? direction : offset);
      if (!solid(grid, x, y)) continue;
      const across = vertical ? grid.x + x : grid.y + y;
      const along = vertical ? grid.y + y : grid.x + x;
      const position = vertical ? p.y : p.x;
      if (
        previousAcross - radius > across + 1 ||
        previousAcross + radius < across ||
        position - radius > along + 1 ||
        position + radius < along
      )
        continue;
      const separated = direction > 0 ? along - margin : along + 1 + margin;
      if (vertical) {
        p.y = separated;
        p.vy = -p.vy * bounce;
      } else {
        p.x = separated;
        p.vx = -p.vx * bounce;
      }
    }
  }

  // Keep these cell indices fixed throughout clipping, as in the reference.
  const x = Math.trunc(p.x - grid.x),
    y = Math.trunc(p.y - grid.y);
  const left = grid.x + x,
    bottom = grid.y + y;
  if (p.x + margin > left + 1 && solid(grid, x + 1, y)) p.x = left + 1 - margin;
  if (p.x - margin < left && solid(grid, x - 1, y)) p.x = left + margin;
  if (p.y + margin > bottom + 1 && solid(grid, x, y + 1)) p.y = bottom + 1 - margin;
  if (p.y - margin < bottom && solid(grid, x, y - 1)) p.y = bottom + margin;

  if (x <= 0) p.x = grid.x + 1 + margin;
  if (x >= grid.w - 1) p.x = grid.x + grid.w - 1 - margin;
  if (y <= 0) p.y = grid.y + 1 + margin;
  if (y >= grid.h - 1) p.y = grid.y + grid.h - 1 - margin;

  // Invalid coordinates are bounded safely; never index outside the cell data.
  if (x < 0 || y < 0 || x >= grid.w || y >= grid.h || !solid(grid, x, y)) return;
  // Embedded-cell recovery preserves the reference side order and strict ties.
  // A later, nearer side may adjust the other coordinate as well.
  const dx = p.x - left,
    dy = p.y - bottom;
  let nearest = 2;
  if (!solid(grid, x - 1, y) && dx < nearest) {
    p.x = left - margin;
    nearest = dx;
  }
  if (!solid(grid, x + 1, y) && 1 - dx < nearest) {
    p.x = left + 1 + margin;
    nearest = 1 - dx;
  }
  if (!solid(grid, x, y - 1) && dy < nearest) {
    p.y = bottom - margin;
    nearest = dy;
  }
  if (!solid(grid, x, y + 1) && 1 - dy < nearest) p.y = bottom + 1 + margin;
}
