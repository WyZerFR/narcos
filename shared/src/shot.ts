import { areaAt } from './areas';
import { areaSpot } from './areaSpots';
import type { MapData } from './collision';
import type { GameData } from './data';
import type { Rect, Vec2 } from './geometry';

/**
 * Point visé par le mode debug `?shot=<area>` : centre de la boîte de l'area s'il est dans son
 * polygone, sinon son point d'arrivée (area en L ou en U). null pour une area inconnue.
 */
export function shotTarget(
  data: MapData & Pick<GameData, 'quartiers'>,
  areaId: string,
  obstacles: readonly Rect[],
): Vec2 | null {
  const area = data.areas.get(areaId);
  if (!area) return null;
  const b = area.bounds;
  const center = { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 };
  return areaAt([area], center) ? center : areaSpot(data, areaId, obstacles);
}
