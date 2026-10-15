import { areaAt } from './areas';
import { isBlocked, type MapData } from './collision';
import type { GameData } from './data';
import type { Rect, Vec2 } from './geometry';
import { interactionPoint } from './locations';

/**
 * Point d'arrivée dans une area (téléportation debug, retour de secours) : devant le bâtiment
 * du bout de son quartier, sinon sous son panneau d'entrée, sinon la case libre la plus proche
 * de son centre. Area verrouillée (aéroport) : devant son portail, côté ville.
 */
export function areaSpot(
  data: MapData & Pick<GameData, 'quartiers'>,
  areaId: string,
  obstacles: readonly Rect[],
): Vec2 | null {
  const area = data.areas.get(areaId);
  if (!area) return null;
  const { config } = data;
  const r = config.world.playerRadius;
  const free = (p: Vec2) =>
    !isBlocked(p, r, obstacles) && areaAt(data.areas.values(), p)?.locked === false;
  const candidates: Vec2[] = [];
  if (area.locked && config.airport.areaId === areaId) {
    const g = config.airport.gate;
    const out = config.airport.fence.inset + 2 * r + 0.5;
    const b = area.bounds;
    candidates.push(
      g.axis === 'x'
        ? { x: g.x, z: g.z > (b.minZ + b.maxZ) / 2 ? g.z + out : g.z - out }
        : { x: g.x > (b.minX + b.maxX) / 2 ? g.x + out : g.x - out, z: g.z },
    );
  }
  const q = [...data.quartiers.values()].find((x) => x.areaId === areaId);
  const landmark = q && data.locations.get(q.landmarkLocationId);
  if (landmark) candidates.push(interactionPoint(landmark));
  for (const g of config.map.areaGates)
    if (g.areaId === areaId) candidates.push({ x: g.x, z: g.z });
  const hit = candidates.find(free);
  if (hit) return { ...hit };
  // case libre la plus proche du centre de l'area, par anneaux de 1 m
  const c = {
    x: (area.bounds.minX + area.bounds.maxX) / 2,
    z: (area.bounds.minZ + area.bounds.maxZ) / 2,
  };
  const reach = Math.max(area.bounds.maxX - area.bounds.minX, area.bounds.maxZ - area.bounds.minZ);
  for (let d = 0; d <= reach; d++)
    for (let i = -d; i <= d; i++)
      for (const p of [
        { x: c.x + i, z: c.z - d },
        { x: c.x + i, z: c.z + d },
        { x: c.x - d, z: c.z + i },
        { x: c.x + d, z: c.z + i },
      ])
        if (areaAt([area], p) && free(p)) return p;
  return null;
}
