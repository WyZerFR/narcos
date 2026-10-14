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

/** Ramène un point dans des bornes. */
export function clampToBounds(p: Vec2, b: Rect): Vec2 {
  return {
    x: Math.min(b.maxX, Math.max(b.minX, p.x)),
    z: Math.min(b.maxZ, Math.max(b.minZ, p.z)),
  };
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Boîte alignée : emprise au sol + hauteur (du sol à `height`). */
export interface Box {
  rect: Rect;
  height: number;
}

/**
 * Le segment [from, to] traverse-t-il la boîte avant d'atteindre `to` ? (méthode des plans)
 * Sert à savoir si un bâtiment cache un joueur à la caméra.
 */
export function segmentHitsBox(from: Vec3, to: Vec3, box: Box): boolean {
  const slabs: [number, number, number, number][] = [
    [from.x, to.x - from.x, box.rect.minX, box.rect.maxX],
    [from.y, to.y - from.y, 0, box.height],
    [from.z, to.z - from.z, box.rect.minZ, box.rect.maxZ],
  ];
  let t0 = 0;
  let t1 = 1;
  for (const [o, dir, min, max] of slabs) {
    if (Math.abs(dir) < 1e-9) {
      if (o < min || o > max) return false;
      continue;
    }
    let a = (min - o) / dir;
    let b = (max - o) / dir;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return false;
  }
  return t0 < 1;
}
