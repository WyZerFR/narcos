import { distance, rectFromCenter, type Rect, type Vec2 } from './geometry';
import type { GameLocation } from './schemas';

/** Emprise au sol d'un lieu ou d'un immeuble. */
export function footprint(l: { position: Vec2; size: { w: number; d: number } }): Rect {
  return rectFromCenter(l.position, l.size);
}

/**
 * Point d'interaction : devant la porte pour un bâtiment (décalé de la moitié du rayon,
 * donc sur le trottoir), centre de la zone pour une ruelle.
 */
export function interactionPoint(loc: GameLocation): Vec2 {
  if (loc.kind === 'area' || !loc.door) return { ...loc.position };
  const r = footprint(loc);
  const out = loc.interactRadius / 2;
  switch (loc.door) {
    case 'north':
      return { x: loc.position.x, z: r.minZ - out };
    case 'south':
      return { x: loc.position.x, z: r.maxZ + out };
    case 'west':
      return { x: r.minX - out, z: loc.position.z };
    case 'east':
      return { x: r.maxX + out, z: loc.position.z };
  }
}

/** Lieu le plus proche dont le rayon d'interaction contient `pos` (ou null). */
export function nearestLocation(
  pos: Vec2,
  locations: Iterable<GameLocation>,
  tolerance = 0,
): GameLocation | null {
  let best: GameLocation | null = null;
  let bestDist = Infinity;
  for (const loc of locations) {
    const d = distance(pos, interactionPoint(loc));
    if (d <= loc.interactRadius + tolerance && d < bestDist) {
      best = loc;
      bestDist = d;
    }
  }
  return best;
}
