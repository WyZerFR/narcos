import { areaAt, walkableAreas } from './areas';
import { isBlocked, obstaclesFrom } from './collision';
import {
  expandRect,
  rectContainsPoint,
  rectFromCenter,
  rectsOverlap,
  type Rect,
  type Vec2,
} from './geometry';
import { greeneryLayout, reservedGround, type GreeneryData } from './greenery';
import { interactionPoint } from './locations';
import { seededRng } from './quartiers';
import type { Theme } from './schemas';

export type GrassParams = NonNullable<Theme['grass']>;

function hash(seed: number, x: number, z: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function seedOf(text: string): number {
  return Math.floor(seededRng(text)() * 2 ** 31);
}

/**
 * Bruit de valeur déterministe (0-1) : treillis haché tous les `scale` m, interpolation lissée.
 * Même graine = même herbe sur toutes les machines.
 */
export function valueNoise(seed: string, scale: number): (x: number, z: number) => number {
  const s = seedOf(seed);
  return (x, z) => {
    const fx = x / scale;
    const fz = z / scale;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const u = tx * tx * (3 - 2 * tx);
    const v = tz * tz * (3 - 2 * tz);
    const a = hash(s, ix, iz);
    const b = hash(s, ix + 1, iz);
    const c = hash(s, ix, iz + 1);
    const d = hash(s, ix + 1, iz + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}

/** Chemins de terre décoratifs : d'un arbre de parcelle sur `pathEvery` vers le trottoir le plus proche. */
export function dirtPaths(data: GreeneryData, grass: GrassParams): Rect[] {
  const { map } = data.config;
  const roads = map.roads.map((r) => expandRect(rectFromCenter(r, r), map.sidewalkWidth));
  const obstacles = obstaclesFrom(data);
  const out: Rect[] = [];
  greeneryLayout(data).trees.forEach((t, i) => {
    if (i % grass.pathEvery !== 0) return;
    let best: Rect | null = null;
    for (const r of roads) {
      // bande axiale de l'arbre jusqu'au bord du trottoir, si elle lui fait face
      const half = grass.pathWidth / 2;
      let strip: Rect | null = null;
      if (t.x >= r.minX && t.x <= r.maxX)
        strip =
          t.z < r.minZ
            ? { minX: t.x - half, maxX: t.x + half, minZ: t.z, maxZ: r.minZ }
            : t.z > r.maxZ
              ? { minX: t.x - half, maxX: t.x + half, minZ: r.maxZ, maxZ: t.z }
              : null;
      else if (t.z >= r.minZ && t.z <= r.maxZ)
        strip =
          t.x < r.minX
            ? { minX: t.x, maxX: r.minX, minZ: t.z - half, maxZ: t.z + half }
            : t.x > r.maxX
              ? { minX: r.maxX, maxX: t.x, minZ: t.z - half, maxZ: t.z + half }
              : null;
      if (!strip) continue;
      const len = Math.max(strip.maxX - strip.minX, strip.maxZ - strip.minZ);
      if (len > grass.pathMaxLength || len < 1) continue;
      if (obstacles.some((o) => rectsOverlap(o, strip))) continue;
      if (!best || len < Math.max(best.maxX - best.minX, best.maxZ - best.minZ)) best = strip;
    }
    if (best) out.push(best);
  });
  return out;
}

export interface GroundCover {
  tufts: (Vec2 & { rotY: number; scale: number })[];
  flowers: (Vec2 & { color: number })[];
  stones: (Vec2 & { rotY: number; scale: number })[];
}

/**
 * Couvert au sol (pur, déterministe) : touffes, fleurs et pierres tirées sur une grille par
 * area (`density`), seulement sur l'herbe : jamais sur une route, un trottoir, une place, un
 * chemin de terre ou un jardin caché, ni près d'une porte, ni dans un passage étroit (distance
 * aux obstacles ≥ `clearance`). Décor sans collision.
 */
export function groundCover(data: GreeneryData, grass: GrassParams): GroundCover {
  const rng = seededRng(`${grass.seed}-couvert`);
  const walkable = walkableAreas(data.areas.values());
  const obstacles = obstaclesFrom(data);
  const blocked = [...reservedGround(data), ...dirtPaths(data, grass)].map((r) =>
    expandRect(r, 0.3),
  );
  const doors = [
    ...[...data.locations.values()].map(interactionPoint),
    ...[...data.quartierLayouts.values()].flatMap((l) => l.houses.map((h) => h.doorStep)),
  ];
  const out: GroundCover = { tufts: [], flowers: [], stones: [] };
  const b = data.config.world.bounds;
  const step = grass.coverSpacing;
  for (let x = b.minX + step / 2; x < b.maxX; x += step)
    for (let z = b.minZ + step / 2; z < b.maxZ; z += step) {
      const p = { x: x + (rng() - 0.5) * step * 0.8, z: z + (rng() - 0.5) * step * 0.8 };
      const roll = rng();
      const area = areaAt(walkable, p);
      const d = area ? grass.density[area.id] : undefined;
      if (!d || roll >= d.tufts + d.flowers + d.stones) continue;
      if (blocked.some((r) => rectContainsPoint(r, p))) continue;
      if (isBlocked(p, grass.clearance, obstacles)) continue;
      if (doors.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < grass.doorClearance)) continue;
      if (roll < d.tufts)
        out.tufts.push({ ...p, rotY: rng() * Math.PI * 2, scale: 0.7 + rng() * 0.6 });
      else if (roll < d.tufts + d.flowers)
        out.flowers.push({ ...p, color: Math.floor(rng() * grass.flowerColors.length) });
      else out.stones.push({ ...p, rotY: rng() * Math.PI * 2, scale: 0.5 + rng() * 0.8 });
    }
  return out;
}
