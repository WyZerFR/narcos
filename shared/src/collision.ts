import { outsideAreas } from './areas';
import type { GameData } from './data';
import { clampToBounds, rectFromCenter, type Rect, type Vec2 } from './geometry';
import { footprint } from './locations';
import type { Bounds } from './schemas';

/** Données dont dépend la carte de la rue (obstacles, navigation). */
export type MapData = Pick<
  GameData,
  'config' | 'locations' | 'blocks' | 'areas' | 'quartierLayouts'
>;

/**
 * Obstacles solides de la carte : bâtiments (lieux `building`), immeubles de remplissage,
 * voitures garées, maisons et décor solide des impasses, et tout ce qui n'est dans aucune area.
 * Les ruelles (`area`) et le petit décor de la rue centrale restent traversables.
 */
export function obstaclesFrom(data: MapData): Rect[] {
  const rects: Rect[] = outsideAreas(data.areas.values(), data.config.world.bounds);
  for (const loc of data.locations.values())
    if (loc.kind === 'building') rects.push(footprint(loc));
  for (const block of data.blocks) rects.push(footprint(block));
  const { length, width } = data.config.decor.carSize;
  for (const car of data.config.decor.cars) {
    const size = car.rotation === 0 ? { w: length, d: width } : { w: width, d: length };
    rects.push(rectFromCenter(car, size));
  }
  // impasses : maisons et décor solide (lampadaires, troncs, poubelles, caisses, clôtures, voitures)
  for (const layout of data.quartierLayouts.values()) rects.push(...layout.colliders);
  return rects;
}

const EPS = 1e-9;

/** Sort un cercle (centre `p`, rayon `r`) des rectangles qu'il pénètre. */
export function resolveCircle(p: Vec2, r: number, rects: readonly Rect[]): Vec2 {
  let x = p.x;
  let z = p.z;
  // Quelques passes suffisent : un cercle coincé entre deux murs se stabilise vite.
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const rect of rects) {
      if (x < rect.minX - r || x > rect.maxX + r || z < rect.minZ - r || z > rect.maxZ + r)
        continue;
      const cx = Math.min(rect.maxX, Math.max(rect.minX, x));
      const cz = Math.min(rect.maxZ, Math.max(rect.minZ, z));
      const dx = x - cx;
      const dz = z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > EPS) {
        // Centre dehors : on repousse le long de la normale au point le plus proche.
        const d = Math.sqrt(d2);
        x = cx + (dx / d) * r;
        z = cz + (dz / d) * r;
      } else {
        // Centre dedans : on sort par la face la plus proche.
        const exits = [
          { d: x - rect.minX, x: rect.minX - r, z },
          { d: rect.maxX - x, x: rect.maxX + r, z },
          { d: z - rect.minZ, x, z: rect.minZ - r },
          { d: rect.maxZ - z, x, z: rect.maxZ + r },
        ];
        const best = exits.reduce((a, b) => (b.d < a.d ? b : a));
        x = best.x;
        z = best.z;
      }
      moved = true;
    }
    if (!moved) break;
  }
  return { x, z };
}

/** Le cercle pénètre-t-il un obstacle (au-delà d'une marge numérique) ? */
export function isBlocked(p: Vec2, r: number, rects: readonly Rect[], margin = 1e-3): boolean {
  const out = resolveCircle(p, r, rects);
  return Math.hypot(out.x - p.x, out.z - p.z) > margin;
}

/**
 * Déplace un cercle de `from` vers `to` en sous-pas (≤ r/2) : impossible de traverser un mur,
 * et la composante tangentielle est conservée → le joueur glisse le long des façades.
 */
export function moveWithCollisions(
  from: Vec2,
  to: Vec2,
  r: number,
  rects: readonly Rect[],
  bounds: Bounds,
): Vec2 {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / (r / 2)));
  let p: Vec2 = { x: from.x, z: from.z };
  for (let i = 0; i < steps; i++) {
    p = { x: p.x + dx / steps, z: p.z + dz / steps };
    p = clampToBounds(resolveCircle(p, r, rects), bounds);
  }
  return p;
}
