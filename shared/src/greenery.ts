import { areaAt, walkableAreas } from './areas';
import { isBlocked, obstaclesFrom, type MapData } from './collision';
import type { GameData } from './data';
import { expandRect, rectContainsPoint, rectFromCenter, type Rect, type Vec2 } from './geometry';
import { interactionPoint } from './locations';
import { seededRng } from './quartiers';

export interface Greenery {
  trees: (Vec2 & { scale: number })[];
  bushes: Vec2[];
}

export type GreeneryData = MapData & Pick<GameData, 'quartierLayouts'>;

const cache = new WeakMap<object, Greenery>();

/** Routes, trottoirs, places et passages réservés (rien n'y pousse). */
export function reservedGround(data: GreeneryData): Rect[] {
  const { map } = data.config;
  const layouts = [...data.quartierLayouts.values()];
  return [
    ...map.roads.map((r) => expandRect(rectFromCenter(r, r), map.sidewalkWidth)),
    ...layouts.flatMap((l) => [
      ...l.roads,
      ...l.sidewalks,
      ...l.parking,
      l.plaza,
      ...l.npcBlocked,
      ...l.gardens.map((g) => g.garden),
    ]),
  ];
}

/**
 * Verdure générée (pure, déterministe par `config.decor.greenery.seed`) : arbres alignés le long
 * des avenues, au-delà du trottoir, puis arbres et buissons dans les parcelles libres. Jamais sur
 * une route, un trottoir, une place, un passage ou un jardin caché, ni près d'une porte ou d'un
 * obstacle. Décor sans collision : obstacles, navigation et trajets inchangés.
 */
export function greeneryLayout(data: GreeneryData): Greenery {
  const hit = cache.get(data.config);
  if (hit) return hit;
  const g = data.config.decor.greenery;
  const { map } = data.config;
  const rng = seededRng(g.seed);
  const walkable = walkableAreas(data.areas.values());
  const obstacles = obstaclesFrom(data);
  const blocked = reservedGround(data).map((r) => expandRect(r, g.clearance));
  const doors = [
    ...[...data.locations.values()].map(interactionPoint),
    ...[...data.quartierLayouts.values()].flatMap((l) => l.houses.map((h) => h.doorStep)),
  ];
  const taken: Vec2[] = data.config.decor.trees.map((t) => ({ x: t.x, z: t.z }));
  const free = (p: Vec2, spacing: number) =>
    areaAt(walkable, p) !== null &&
    !blocked.some((r) => rectContainsPoint(r, p)) &&
    !isBlocked(p, g.clearance, obstacles) &&
    doors.every((d) => Math.hypot(d.x - p.x, d.z - p.z) >= g.doorClearance) &&
    taken.every((t) => Math.hypot(t.x - p.x, t.z - p.z) >= spacing / 2);
  const scale = () => g.scale.min + rng() * (g.scale.max - g.scale.min);
  const out: Greenery = { trees: [], bushes: [] };

  // avenues : une rangée de chaque côté, au-delà du trottoir
  for (const road of map.roads.map((r) => rectFromCenter(r, r))) {
    const alongX = road.maxX - road.minX >= road.maxZ - road.minZ;
    const edge = map.sidewalkWidth + g.avenueOffset + g.clearance;
    const sides = alongX
      ? [road.minZ - edge, road.maxZ + edge]
      : [road.minX - edge, road.maxX + edge];
    const [from, to] = alongX ? [road.minX, road.maxX] : [road.minZ, road.maxZ];
    for (const off of sides)
      for (let t = from + g.avenueSpacing / 2; t < to; t += g.avenueSpacing) {
        const p = alongX ? { x: t, z: off } : { x: off, z: t };
        if (!free(p, g.avenueSpacing)) continue;
        taken.push(p);
        out.trees.push({ ...p, scale: scale() });
      }
  }
  // parcelles libres : grille légèrement décalée, une chance par case
  const b = data.config.world.bounds;
  for (let x = b.minX + g.parcelSpacing / 2; x < b.maxX; x += g.parcelSpacing)
    for (let z = b.minZ + g.parcelSpacing / 2; z < b.maxZ; z += g.parcelSpacing) {
      const jitter = g.parcelSpacing * 0.3;
      const p = { x: x + (rng() - 0.5) * jitter, z: z + (rng() - 0.5) * jitter };
      if (rng() >= g.parcelChance || !free(p, g.parcelSpacing)) continue;
      taken.push(p);
      if (rng() < g.bushShare) out.bushes.push(p);
      else out.trees.push({ ...p, scale: scale() });
    }
  cache.set(data.config, out);
  return out;
}
