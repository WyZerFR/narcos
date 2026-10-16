import { outsideAreas, walkableAreas } from './areas';
import { airportObstacles } from './airport';
import type { GameData } from './data';
import {
  clampToBounds,
  expandRect,
  isNarrowGap,
  rectContainsPoint,
  rectFromCenter,
  type Rect,
  type Vec2,
} from './geometry';
import { footprint } from './locations';
import { placementObstacles } from './props';
import type { Bounds } from './schemas';

/** Données dont dépend la carte de la rue (obstacles, navigation). */
export type MapData = Pick<
  GameData,
  'config' | 'locations' | 'blocks' | 'areas' | 'quartierLayouts' | 'props' | 'placements'
>;

/**
 * Obstacles solides de la carte : bâtiments (lieux `building`), immeubles de remplissage, props posés,
 * voitures garées, maisons et décor solide des quartiers, et tout ce qui n'est dans aucune area
 * marchable (mer, area verrouillée).
 * Les ruelles (`area`) et le petit décor de la rue centrale restent traversables.
 */
export function obstaclesFrom(data: MapData): Rect[] {
  // mer, côte et areas verrouillées (aéroport) : hors-zone, calculé sur la carte élargie d'un
  // gabarit de joueur pour que la côte au bord de la carte soit un vrai obstacle (pas un simple
  // bornage du centre, qui laisserait le corps au-dessus de l'eau)
  const { world } = data.config;
  const rects: Rect[] = outsideAreas(
    walkableAreas(data.areas.values()),
    expandRect(world.bounds, world.playerSize),
  );
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
  // aéroport : portail fermé tant que l'area est verrouillée, clôture et volumes une fois ouverte
  rects.push(...airportObstacles(data.config.airport, data.areas));
  // décor 3D posé (placements.json) : boîtes simples de props.json
  rects.push(...placementObstacles(data));
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
  /** Sous-pas maximal (m) ; défaut : demi-rayon. Toujours plafonné au demi-rayon. */
  maxSubStep = r / 2,
): Vec2 {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const sub = Math.min(maxSubStep, r / 2);
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / sub));
  const sx = dx / steps;
  const sz = dz / steps;
  const want = Math.hypot(sx, sz);
  let p: Vec2 = { x: from.x, z: from.z };
  for (let i = 0; i < steps; i++) {
    const at = p;
    // progression dans la direction voulue
    const progress = (q: Vec2) => ((q.x - at.x) * sx + (q.z - at.z) * sz) / (want || 1);
    let next = settle({ x: at.x + sx, z: at.z + sz }, r, rects, bounds, at);
    // coin saillant pris de face : la poussée annule le pas ; on glisse par un seul axe
    if (progress(next) < SLIDE_FALLBACK * want)
      for (const alt of [
        settle({ x: at.x + sx, z: at.z }, r, rects, bounds, at),
        settle({ x: at.x, z: at.z + sz }, r, rects, bounds, at),
      ])
        if (progress(alt) > progress(next)) next = alt;
    // Poussée dans un renfoncement (deux coins proches) : la résolution peut renvoyer en
    // arrière, puis de nouveau en avant à la frame suivante → tremblement. Depuis une position
    // libre, un sous-pas qui recule est refusé : on reste contre l'obstacle.
    if (progress(next) < -EPS_PROGRESS && !isBlocked(at, r, rects)) next = at;
    p = next;
  }
  return p;
}

/** Sous-pas qui avance de moins de cette fraction du voulu : essai par axes séparés. */
const SLIDE_FALLBACK = 0.5;
/** Recul toléré (m) d'un sous-pas avant de le refuser (bruit numérique). */
const EPS_PROGRESS = 1e-6;

/**
 * Place un cercle hors des obstacles ET dans les bornes. Les deux contraintes sont résolues
 * ensemble, en quelques passes : sinon la remise dans les bornes peut renvoyer le joueur dans
 * un meuble collé au mur. S'il reste coincé (fente plus étroite que lui), il est éjecté vers
 * le point libre le plus proche (au plus un rayon) ; à défaut, il reste à `fallback`.
 */
export function settle(
  p: Vec2,
  r: number,
  rects: readonly Rect[],
  bounds: Bounds,
  fallback: Vec2,
): Vec2 {
  let q = p;
  for (let pass = 0; pass < 4; pass++) {
    const out = resolveCircle(q, r, rects);
    const inside = clampToBounds(out, bounds);
    q = inside;
    if (inside.x === out.x && inside.z === out.z) break;
  }
  if (!isBlocked(q, r, rects)) return q;
  return ejectToFree(q, r, rects, bounds, r) ?? fallback;
}

const EJECT_RINGS = 8;
const EJECT_ANGLES = 16;

/** Point libre (dans les bornes) le plus proche de `p`, à au plus `maxDist`, ou null. */
export function ejectToFree(
  p: Vec2,
  r: number,
  rects: readonly Rect[],
  bounds: Bounds,
  maxDist: number,
): Vec2 | null {
  for (let ring = 1; ring <= EJECT_RINGS; ring++) {
    const d = (maxDist * ring) / EJECT_RINGS;
    for (let k = 0; k < EJECT_ANGLES; k++) {
      const a = (k / EJECT_ANGLES) * Math.PI * 2;
      const c = clampToBounds({ x: p.x + Math.cos(a) * d, z: p.z + Math.sin(a) * d }, bounds);
      if (!isBlocked(c, r, rects)) return c;
    }
  }
  return null;
}

/** Milieu de l'écart entre deux rectangles (dans la bande commune s'ils se font face). */
export function gapMiddle(a: Rect, b: Rect): Vec2 {
  const mid = (a0: number, a1: number, b0: number, b1: number) =>
    a1 < b0 ? (a1 + b0) / 2 : b1 < a0 ? (b1 + a0) / 2 : (Math.max(a0, b0) + Math.min(a1, b1)) / 2;
  return { x: mid(a.minX, a.maxX, b.minX, b.maxX), z: mid(a.minZ, a.maxZ, b.minZ, b.maxZ) };
}

/**
 * Fentes : paires d'obstacles séparés d'un écart non nul plus petit que `minGap` (diamètre du
 * joueur + marge), dont le milieu n'est pas rempli par un troisième obstacle. Un obstacle
 * doit toucher ses voisins ou laisser un vrai passage.
 */
export function findSlits(rects: readonly Rect[], minGap: number): [Rect, Rect][] {
  const out: [Rect, Rect][] = [];
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!;
      const b = rects[j]!;
      if (!isNarrowGap(a, b, minGap)) continue;
      const m = gapMiddle(a, b);
      if (!rects.some((o, k) => k !== i && k !== j && rectContainsPoint(o, m))) out.push([a, b]);
    }
  return out;
}
