import type { Bounds } from './schemas';

/** Rectangle aligné sur les axes, en bornes (même forme que `Bounds`). */
export type Rect = Bounds;

export interface Vec2 {
  x: number;
  z: number;
}

/** Rectangle à partir d'un centre et d'une taille (w sur X, d sur Z). */
export function rectFromCenter(center: Vec2, size: { w: number; d: number }): Rect {
  return {
    minX: center.x - size.w / 2,
    maxX: center.x + size.w / 2,
    minZ: center.z - size.d / 2,
    maxZ: center.z + size.d / 2,
  };
}

export function expandRect(r: Rect, by: number): Rect {
  return { minX: r.minX - by, maxX: r.maxX + by, minZ: r.minZ - by, maxZ: r.maxZ + by };
}

/** Chevauchement strict (des rectangles qui se touchent ne se chevauchent pas). */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}

export function rectContainsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.minX >= outer.minX &&
    inner.maxX <= outer.maxX &&
    inner.minZ >= outer.minZ &&
    inner.maxZ <= outer.maxZ
  );
}

export function rectContainsPoint(r: Rect, p: Vec2): boolean {
  return p.x >= r.minX && p.x <= r.maxX && p.z >= r.minZ && p.z <= r.maxZ;
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
