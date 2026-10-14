import { obstaclesFrom } from './collision';
import type { GameData } from './data';
import { distance, rectFromCenter, type Rect, type Vec2 } from './geometry';
import type { Interior, Station } from './schemas';

/**
 * Zones de jeu : la rue (carte du quartier) ou un intérieur (`zones.json`). Chaque joueur est
 * dans exactement une zone ; mouvements, collisions et interactions dépendent de celle-ci.
 * (À ne pas confondre avec les quartiers zone1/2/3 de `locations.json`.)
 */
export const STREET = 'street';

/** Bornes de déplacement dans un intérieur (pièce centrée sur l'origine). */
export function interiorBounds(interior: Interior): Rect {
  return rectFromCenter({ x: 0, z: 0 }, interior.size);
}

/** Obstacles d'un intérieur : obstacles déclarés + postes solides. */
export function interiorObstacles(interior: Interior): Rect[] {
  return [
    ...interior.obstacles.map((o) => rectFromCenter(o, o)),
    ...interior.stations.filter((s) => s.solid).map((s) => rectFromCenter(s.position, s.size)),
  ];
}

export interface ZoneArea {
  bounds: Rect;
  obstacles: Rect[];
}

/** Bornes + obstacles de la zone (rue ou intérieur). `null` si la zone est inconnue. */
export function zoneArea(
  data: Pick<GameData, 'config' | 'locations' | 'blocks' | 'interiors'>,
  zoneId: string,
): ZoneArea | null {
  if (zoneId === STREET)
    return { bounds: data.config.world.bounds, obstacles: obstaclesFrom(data) };
  const interior = data.interiors.get(zoneId);
  return interior
    ? { bounds: interiorBounds(interior), obstacles: interiorObstacles(interior) }
    : null;
}

/** Intérieur auquel mène la porte d'un lieu de la rue, s'il y en a un. */
export function interiorForLocation(
  data: Pick<GameData, 'interiors'>,
  locationId: string,
): Interior | undefined {
  for (const interior of data.interiors.values()) {
    if (interior.entranceLocationId === locationId) return interior;
  }
  return undefined;
}

/** Poste le plus proche dont le rayon d'interaction contient `pos` (ou null). */
export function nearestStation(pos: Vec2, interior: Interior, tolerance = 0): Station | null {
  let best: Station | null = null;
  let bestDist = Infinity;
  for (const station of interior.stations) {
    const d = distance(pos, station.position);
    if (d <= station.interactRadius + tolerance && d < bestDist) {
      best = station;
      bestDist = d;
    }
  }
  return best;
}
