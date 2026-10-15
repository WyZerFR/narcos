import type { Rect, Vec2 } from './geometry';
import type { Area, Bounds } from './schemas';

/**
 * Areas de l'île (`areas.json`) : polygones rectilignes (Bas-fonds, centre-ville, quartiers…).
 * Pur : le serveur s'en sert pour l'area d'un joueur ou d'un PNJ (prix, demande, danger), la
 * collision pour la côte (hors des areas = infranchissable), le client pour le HUD et le sol.
 * Une frontière commune appartient à la première area déclarée.
 */

/** `p` dans le polygone rectiligne `poly`, bord compris. */
export function polygonContainsPoint(poly: readonly Vec2[], p: Vec2): boolean {
  let inside = false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const onEdge =
      a.z === b.z
        ? p.z === a.z && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x)
        : p.x === a.x && p.z >= Math.min(a.z, b.z) && p.z <= Math.max(a.z, b.z);
    if (onEdge) return true;
    // rayon vers +X : seuls les côtés verticaux le coupent
    if (a.z > p.z !== b.z > p.z && p.x < a.x) inside = !inside;
  }
  return inside;
}

/** Area contenant `p` (bord compris, première déclarée en cas de frontière), ou null en mer. */
export function areaAt(areas: Iterable<Area>, p: Vec2): Area | null {
  for (const area of areas) if (polygonContainsPoint(area.polygon, p)) return area;
  return null;
}

/** Danger (0 à 5) au point `p`, ou null hors de l'île. Point d'accroche de la police. */
export function dangerAt(areas: Iterable<Area>, p: Vec2): number | null {
  return areaAt(areas, p)?.dangerLevel ?? null;
}

/** Areas où l'on peut marcher (les verrouillées, comme l'aéroport, sont hors-zone). */
export function walkableAreas(areas: Iterable<Area>): Area[] {
  return [...areas].filter((a) => !a.locked);
}

/** Plus petit rectangle contenant toutes les areas (taille de la carte). */
export function areasEnvelope(areas: Iterable<Area>): Bounds {
  const list = [...areas];
  return {
    minX: Math.min(...list.map((a) => a.bounds.minX)),
    maxX: Math.max(...list.map((a) => a.bounds.maxX)),
    minZ: Math.min(...list.map((a) => a.bounds.minZ)),
    maxZ: Math.max(...list.map((a) => a.bounds.maxZ)),
  };
}

/**
 * Découpe `frame` en grille sur les sommets des polygones et garde les cases dont le centre
 * vérifie `keep`, fusionnées par rangée. Exact pour des polygones rectilignes.
 */
function gridRects(polys: readonly (readonly Vec2[])[], frame: Bounds, keep: (p: Vec2) => boolean) {
  const cuts = (lo: number, hi: number, values: number[]) =>
    [...new Set([lo, hi, ...values.filter((v) => v > lo && v < hi)])].sort((a, b) => a - b);
  const xs = cuts(
    frame.minX,
    frame.maxX,
    polys.flatMap((p) => p.map((v) => v.x)),
  );
  const zs = cuts(
    frame.minZ,
    frame.maxZ,
    polys.flatMap((p) => p.map((v) => v.z)),
  );
  const out: Rect[] = [];
  for (let j = 0; j + 1 < zs.length; j++) {
    let run: Rect | null = null;
    for (let i = 0; i + 1 < xs.length; i++) {
      const cell = { minX: xs[i]!, maxX: xs[i + 1]!, minZ: zs[j]!, maxZ: zs[j + 1]! };
      const ok = keep({ x: (cell.minX + cell.maxX) / 2, z: (cell.minZ + cell.maxZ) / 2 });
      if (ok && run && run.maxX === cell.minX) run.maxX = cell.maxX;
      else if (ok) out.push((run = cell));
      else run = null;
    }
  }
  return out;
}

/** Rectangles qui pavent exactement une area (sol, mini-carte, chevauchements). */
export function areaRects(area: Area): Rect[] {
  return gridRects([area.polygon], area.bounds, (p) => polygonContainsPoint(area.polygon, p));
}

/**
 * Parties de `world` couvertes par aucune des `areas` (mer, côte, area verrouillée si on ne
 * passe que les marchables) : obstacles pleins pour que joueurs et PNJ restent sur l'île.
 */
export function outsideAreas(areas: Iterable<Area>, world: Bounds): Rect[] {
  const list = [...areas];
  return gridRects(
    list.map((a) => a.polygon),
    world,
    (p) => !list.some((a) => polygonContainsPoint(a.polygon, p)),
  );
}

/** Le rectangle `r` est entièrement dans l'area (bord compris). */
export function areaContainsRect(area: Area, r: Rect): boolean {
  return gridRects([area.polygon], r, (p) => !polygonContainsPoint(area.polygon, p)).length === 0;
}

/** Deux rectangles partagent un bord de longueur non nulle (contact franc, pas un coin). */
function shareEdge(a: Rect, b: Rect): boolean {
  const overlapX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const overlapZ = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
  return (
    ((a.maxX === b.minX || b.maxX === a.minX) && overlapZ > 0) ||
    ((a.maxZ === b.minZ || b.maxZ === a.minZ) && overlapX > 0)
  );
}

/**
 * Voisines directes de chaque area (bord commun) : le client garde chargées l'area du joueur et
 * celles-ci, le reste de l'île est déchargé.
 */
export function areaNeighbors(areas: Iterable<Area>): Map<string, string[]> {
  const list = [...areas];
  const tiles = new Map(list.map((a) => [a.id, areaRects(a)]));
  const out = new Map<string, string[]>();
  for (const a of list)
    out.set(
      a.id,
      list
        .filter(
          (b) =>
            b !== a && tiles.get(a.id)!.some((r) => tiles.get(b.id)!.some((o) => shareEdge(r, o))),
        )
        .map((b) => b.id),
    );
  return out;
}

/** Area contenant `p`, sinon la plus proche (bord de mer, plage) : rattache le décor côtier. */
export function nearestArea(areas: Iterable<Area>, p: Vec2): Area | null {
  const list = [...areas];
  const inside = areaAt(list, p);
  if (inside) return inside;
  let best: Area | null = null;
  let bestD = Infinity;
  for (const a of list)
    for (const r of areaRects(a)) {
      const dx = Math.max(r.minX - p.x, 0, p.x - r.maxX);
      const dz = Math.max(r.minZ - p.z, 0, p.z - r.maxZ);
      const d = Math.hypot(dx, dz);
      if (d < bestD) [best, bestD] = [a, d];
    }
  return best;
}
