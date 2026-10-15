import { footprint } from './locations';
import { rectContainsRect, type Rect } from './geometry';
import type { Area, Bounds, GameLocation, QuartierParams } from './schemas';

/**
 * Quartiers en impasse (`quartiers.json`) : repère géométrique d'une impasse et, plus bas,
 * générateur déterministe des maisons et du décor. Pur : même entrée, même résultat sur le
 * client et le serveur.
 */

/**
 * Repère d'une impasse : elle part du bord de l'area collé à la rue et s'enfonce selon `dir`
 * (-1 = vers -Z, quartier nord ; +1 = vers +Z, quartier sud), le long de l'axe x = `axisX`.
 * Les distances `t` se mesurent depuis l'entrée.
 */
export interface QuartierFrame {
  dir: 1 | -1;
  axisX: number;
  entranceZ: number;
  /** Demi-largeur chaussée + stationnement, puis bord extérieur du trottoir. */
  roadwayHalf: number;
  sidewalkOuter: number;
  housesStart: number;
  housesEnd: number;
  /** Fin de la placette = façade du bâtiment du bout. */
  plazaEnd: number;
}

/** Repère de l'impasse, ou null si l'area ne touche pas la rue au nord ou au sud. */
export function quartierFrame(
  q: QuartierParams,
  area: Bounds,
  street: Bounds,
): QuartierFrame | null {
  const dir = area.maxZ === street.minZ ? -1 : area.minZ === street.maxZ ? 1 : null;
  if (dir === null) return null;
  const s = q.street;
  const roadwayHalf = s.roadWidth / 2 + s.parkingWidth;
  const housesStart = s.entranceClear;
  const housesEnd = housesStart + s.housesLength;
  return {
    dir,
    axisX: (area.minX + area.maxX) / 2,
    entranceZ: dir < 0 ? area.maxZ : area.minZ,
    roadwayHalf,
    sidewalkOuter: roadwayHalf + s.sidewalkWidth,
    housesStart,
    housesEnd,
    plazaEnd: housesEnd + s.plazaDepth,
  };
}

/** Coordonnée z à la distance `t` de l'entrée. */
export const alongZ = (f: QuartierFrame, t: number) => f.entranceZ + f.dir * t;

/** Rectangle entre les distances `t0` et `t1`, sur |x − axe| ≤ `half`. */
export function bandRect(f: QuartierFrame, t0: number, t1: number, half: number): Rect {
  const a = alongZ(f, t0);
  const b = alongZ(f, t1);
  return {
    minX: f.axisX - half,
    maxX: f.axisX + half,
    minZ: Math.min(a, b),
    maxZ: Math.max(a, b),
  };
}

/** Cohérence d'une impasse avec son area et son bâtiment du bout. */
export function checkQuartier(
  q: QuartierParams,
  areas: ReadonlyMap<string, Area>,
  locations: ReadonlyMap<string, GameLocation>,
): string[] {
  const where = `quartiers.json : "${q.id}"`;
  const area = areas.get(q.areaId);
  const street = areas.get('street');
  if (!area || !street || area.id === 'street') return [`${where} : area "${q.areaId}" inconnue`];
  const f = quartierFrame(q, area.bounds, street.bounds);
  if (!f) return [`${where} : l'area "${area.id}" doit toucher la rue au nord ou au sud`];
  const errors: string[] = [];
  const h = q.houses;
  const deepest = f.sidewalkOuter + h.setback[1] + h.depth[1];
  if (!rectContainsRect(area.bounds, bandRect(f, 0, f.plazaEnd, deepest)))
    errors.push(`${where} : les maisons débordent de l'area "${area.id}"`);
  if (q.street.housesLength / h.perSide[1] < h.width[0] + h.gap[0])
    errors.push(`${where} : housesLength trop court pour perSide max (largeur + écart min)`);
  if (q.street.plazaWidth / 2 < f.sidewalkOuter)
    errors.push(`${where} : la placette doit être au moins aussi large que la rue`);
  const loc = locations.get(q.landmarkLocationId);
  if (!loc || loc.kind !== 'building')
    return [...errors, `${where} : bâtiment du bout "${q.landmarkLocationId}" inconnu`];
  const r = footprint(loc);
  const front = f.dir < 0 ? r.maxZ : r.minZ;
  if (Math.abs(loc.position.x - f.axisX) > 0.01)
    errors.push(`${where} : "${loc.id}" doit être centré sur l'axe x = ${f.axisX}`);
  if (Math.abs(front - alongZ(f, f.plazaEnd)) > 0.01)
    errors.push(`${where} : la façade de "${loc.id}" doit être en z = ${alongZ(f, f.plazaEnd)}`);
  if (loc.door !== (f.dir < 0 ? 'south' : 'north'))
    errors.push(`${where} : la porte de "${loc.id}" doit regarder la rue`);
  if (!rectContainsRect(area.bounds, r))
    errors.push(`${where} : "${loc.id}" déborde de l'area "${area.id}"`);
  return errors;
}
