import { rectContainsPoint, type Rect, type Vec2 } from './geometry';
import type { Area, Bounds } from './schemas';

/**
 * Areas de la rue (`areas.json`) : rue centrale et quartiers en impasse. Pur : le serveur s'en
 * sert pour l'area d'un joueur ou d'un PNJ (prix, demande), le client pour le HUD.
 * Une frontière commune appartient à la première area déclarée (la rue est en tête).
 */

/** Area contenant `p` (bornes incluses, première déclarée en cas de frontière), ou null hors carte. */
export function areaAt(areas: Iterable<Area>, p: Vec2): Area | null {
  for (const area of areas) if (rectContainsPoint(area.bounds, p)) return area;
  return null;
}

/** Danger (0 à 5) au point `p`, ou null hors carte. Point d'accroche de la police. */
export function dangerAt(areas: Iterable<Area>, p: Vec2): number | null {
  return areaAt(areas, p)?.dangerLevel ?? null;
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
 * Parties de la carte couvertes par aucune area (autour des impasses) : obstacles pleins,
 * pour que joueurs et PNJ restent dans les areas. Découpe en grille sur les bords des areas,
 * puis fusion des cellules d'une même rangée.
 */
export function outsideAreas(areas: Iterable<Area>, world: Bounds): Rect[] {
  const list = [...areas];
  const cuts = (lo: number, hi: number, values: number[]) =>
    [...new Set([lo, hi, ...values.filter((v) => v > lo && v < hi)])].sort((a, b) => a - b);
  const xs = cuts(
    world.minX,
    world.maxX,
    list.flatMap((a) => [a.bounds.minX, a.bounds.maxX]),
  );
  const zs = cuts(
    world.minZ,
    world.maxZ,
    list.flatMap((a) => [a.bounds.minZ, a.bounds.maxZ]),
  );
  const out: Rect[] = [];
  for (let j = 0; j + 1 < zs.length; j++) {
    let run: Rect | null = null;
    for (let i = 0; i + 1 < xs.length; i++) {
      const cell = { minX: xs[i]!, maxX: xs[i + 1]!, minZ: zs[j]!, maxZ: zs[j + 1]! };
      const mid = { x: (cell.minX + cell.maxX) / 2, z: (cell.minZ + cell.maxZ) / 2 };
      const covered = list.some((a) => rectContainsPoint(a.bounds, mid));
      if (!covered && run && run.maxX === cell.minX) run.maxX = cell.maxX;
      else if (!covered) out.push((run = cell));
      else run = null;
    }
  }
  return out;
}
