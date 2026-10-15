import { isBlocked } from './collision';
import type { GameData } from './data';
import {
  fixtureRect,
  furnitureFixture,
  isSolidFixture,
  normRot,
  type Fixture,
  type Furniture,
} from './fixtures';
import {
  distance,
  expandRect,
  isNarrowGap,
  rectContainsRect,
  rectFromCenter,
  rectsOverlap,
  type Rect,
  type Vec2,
} from './geometry';
import type { FixtureType, Interior } from './schemas';
import { interiorBounds, interiorObstacles } from './zones';
import { cellIndex, createNavGrid, distancesFrom } from './navgrid';

/**
 * Placement libre des meubles du labo : une seule règle, utilisée par le serveur (autorité) et
 * par le client (couleur du fantôme). Pur, sans état.
 */

export type PlacementError =
  | 'not_placeable'
  | 'not_here'
  | 'bad_position'
  | 'limit'
  | 'out_of_room'
  | 'door'
  | 'station'
  | 'furniture'
  | 'player'
  | 'gap'
  | 'enclose';

export type PlacementResult =
  { ok: true; fixture: Fixture } | { ok: false; reason: PlacementError; message: string };

export interface PlacementRequest {
  itemId: string;
  x: number;
  z: number;
  rot: number;
  /** Meuble déplacé : ignoré dans les chevauchements et le plafond par type. */
  ignoreId?: string;
}

export interface PlacementContext {
  interior: Interior;
  /** Meubles déjà posés dans la pièce. */
  fixtures: readonly Fixture[];
  /** Joueurs présents dans la pièce (on ne pose pas un meuble sur quelqu'un). */
  players: readonly Vec2[];
}

type Data = Pick<GameData, 'items' | 'economy' | 'config'>;

const refuse = (reason: PlacementError, message: string): PlacementResult => ({
  ok: false,
  reason,
  message,
});

/** Nombre maximal de meubles d'un type dans le labo (economy.lab.furniture). */
export function maxOfType(data: Pick<GameData, 'economy'>, type: FixtureType): number {
  return data.economy.lab.furniture.maxPerType[type];
}

/** Zone interdite devant la porte (sortie + dégagement), pour les meubles au sol. */
export function doorZones(data: Pick<GameData, 'economy'>, interior: Interior): Rect[] {
  const clearance = data.economy.lab.furniture.doorClearance;
  return interior.stations
    .filter((s) => s.kind === 'exit')
    .map((s) => expandRect(rectFromCenter(s.position, s.size), clearance));
}

/** Vérifie qu'un meuble peut être posé là. Message clair en cas de refus. */
export function checkPlacement(
  data: Data,
  ctx: PlacementContext,
  req: PlacementRequest,
): PlacementResult {
  const { interior } = ctx;
  const def = data.items.get(req.itemId);
  if (!def?.placeable) return refuse('not_placeable', 'Cet objet ne se pose pas.');
  if (!interior.furnishable) return refuse('not_here', 'À poser dans ton labo.');
  if (![req.x, req.z, req.rot].every(Number.isFinite) || !Number.isInteger(req.rot))
    return refuse('bad_position', 'Position invalide.');
  const fixture = furnitureFixture(
    { id: req.ignoreId ?? '', itemId: req.itemId, x: req.x, z: req.z, rot: normRot(req.rot) },
    data.items,
  )!;
  const others = ctx.fixtures.filter((f) => f.id !== req.ignoreId);

  const max = maxOfType(data, fixture.accepts);
  if (others.filter((f) => f.accepts === fixture.accepts).length >= max)
    return refuse('limit', `Maximum ${max} × ${def.name} dans le labo.`);

  const rect = fixtureRect(fixture);
  if (!rectContainsRect(interiorBounds(interior), rect))
    return refuse('out_of_room', 'Ça dépasse du mur.');

  // Au plafond (lampes) : seules les autres lampes gênent ; le sol reste libre.
  const sameLayer = others.filter((f) => f.mount === fixture.mount);
  if (!isSolidFixture(fixture)) {
    const hit = sameLayer.find((f) => rectsOverlap(fixtureRect(f), rect));
    return hit ? refuse('furniture', `Ça touche : ${hit.label}.`) : { ok: true, fixture };
  }

  if (doorZones(data, interior).some((z) => rectsOverlap(z, rect)))
    return refuse('door', 'Laisse la porte dégagée.');
  for (const st of interior.stations)
    if (st.solid && rectsOverlap(rectFromCenter(st.position, st.size), rect))
      return refuse('station', `Trop près : ${st.label}.`);
  if (interior.obstacles.some((o) => rectsOverlap(rectFromCenter(o, o), rect)))
    return refuse('station', 'Il y a déjà quelque chose ici.');
  const hit = sameLayer.find((f) => rectsOverlap(fixtureRect(f), rect));
  if (hit) return refuse('furniture', `Ça touche : ${hit.label}.`);
  const radius = data.config.world.playerRadius;
  if (ctx.players.some((p) => isBlocked(p, radius, [rect])))
    return refuse('player', "Quelqu'un est dans le passage.");
  // ni fente avec les murs, les postes ou les meubles : collé, ou un vrai passage
  const minGap = 2 * radius + data.config.collision.passageMargin;
  const room = interiorBounds(interior);
  const solids = [
    ...interiorObstacles(interior),
    ...sameLayer.map(fixtureRect),
    ...roomWalls(room),
  ];
  if (solids.some((o) => isNarrowGap(o, rect, minGap)))
    return refuse(
      'gap',
      `Colle-le ou laisse au moins ${minGap.toFixed(1)} m de passage (mur, poste, meuble).`,
    );
  // la porte reste atteignable depuis chaque joueur et depuis l'entrée de la pièce
  if (!doorReachable(data, interior, [...solids, rect], [...ctx.players, interior.spawn]))
    return refuse('enclose', 'Ça couperait le chemin vers la porte.');
  return { ok: true, fixture };
}

/** Murs (épais) autour de la pièce : un meuble à 30 cm du mur forme une fente. */
function roomWalls(b: Rect, t = 1): Rect[] {
  return [
    { minX: b.minX - t, maxX: b.maxX + t, minZ: b.minZ - t, maxZ: b.minZ },
    { minX: b.minX - t, maxX: b.maxX + t, minZ: b.maxZ, maxZ: b.maxZ + t },
    { minX: b.minX - t, maxX: b.minX, minZ: b.minZ, maxZ: b.maxZ },
    { minX: b.maxX, maxX: b.maxX + t, minZ: b.minZ, maxZ: b.maxZ },
  ];
}

/** Chaque point de `from` rejoint-il la sortie à pied (grille de navigation fine) ? */
function doorReachable(data: Data, interior: Interior, obstacles: Rect[], from: Vec2[]): boolean {
  const exit = interior.stations.find((s) => s.kind === 'exit');
  if (!exit) return true;
  const radius = data.config.world.playerRadius;
  const grid = createNavGrid(interiorBounds(interior), obstacles, radius, NAV_CELL);
  // devant la porte, côté pièce
  const door = { x: exit.position.x, z: exit.position.z - exit.size.d - radius };
  const dist = distancesFrom(grid, door);
  return from.every((p) => Number.isFinite(dist[cellIndex(grid, p)] ?? Infinity));
}

/** Pas de la grille du contrôle d'enfermement (m) : fin, la pièce est petite. */
const NAV_CELL = 0.2;

/** Joueur vu par les règles de placement (pour nommer qui gêne). */
export interface Occupant extends Vec2 {
  id: string;
  name: string;
}

/**
 * Qui se sert de ce meuble, hormis `selfId` : la découpe en cours à son nom (`cutterId`),
 * ou un autre joueur à portée. Null si le poste est libre (on peut le déplacer).
 */
export function fixtureUser(
  f: Pick<Fixture, 'position' | 'interactRadius'>,
  occupants: readonly Occupant[],
  selfId: string,
  tolerance: number,
  cutterId?: string,
): string | null {
  if (cutterId && cutterId !== selfId)
    return occupants.find((p) => p.id === cutterId)?.name ?? 'Un associé';
  const reach = f.interactRadius + tolerance;
  const other = occupants.find((p) => p.id !== selfId && distance(p, f.position) <= reach);
  return other?.name ?? null;
}

/**
 * Meuble sous un point du sol (appui long) : celui dont l'empreinte, élargie de `margin`,
 * contient le point ; le plus proche de son centre, les meubles au sol avant les lampes.
 */
export function fixtureAt(point: Vec2, fixtures: readonly Fixture[], margin = 0): Fixture | null {
  let best: Fixture | null = null;
  let bestScore = Infinity;
  for (const f of fixtures) {
    const r = expandRect(fixtureRect(f), margin);
    if (point.x < r.minX || point.x > r.maxX || point.z < r.minZ || point.z > r.maxZ) continue;
    const score = distance(point, f.position) + (isSolidFixture(f) ? 0 : 1000);
    if (score < bestScore) {
      best = f;
      bestScore = score;
    }
  }
  return best;
}

/** Arrondi au pas de placement (évite les 0.6000000001). */
export function snap(v: number, step: number): number {
  return Math.round(Math.round(v / step) * step * 1000) / 1000;
}

/**
 * Agencement automatique valide (debug « équiper », tests) : pour chaque objet demandé, première
 * case libre d'une grille au pas de placement, en gardant un couloir praticable entre
 * les meubles au sol. Les lampes se mettent au plus près des pots. Renvoie les meubles à créer
 * (sans id), en s'arrêtant pour un objet quand plus rien ne rentre.
 */
export function generateLayout(
  data: Data,
  ctx: PlacementContext,
  wanted: readonly { itemId: string; count: number }[],
): Omit<Furniture, 'id'>[] {
  const step = data.config.placement.stepM;
  // couloir : un diamètre de joueur et demi entre deux meubles au sol (on circule et on atteint)
  const gap = data.config.world.playerRadius * 3;
  const bounds = interiorBounds(ctx.interior);
  const placed: Fixture[] = [...ctx.fixtures];
  const out: Omit<Furniture, 'id'>[] = [];
  for (const { itemId, count } of wanted) {
    const def = data.items.get(itemId);
    if (!def?.placeable) continue;
    for (let n = 0; n < count; n++) {
      const candidates: { x: number; z: number; rot: number; score: number }[] = [];
      const pots = placed.filter((f) => f.accepts === 'pot').map((f) => f.position);
      for (const rot of [0, 1]) {
        for (let z = bounds.minZ; z <= bounds.maxZ; z += step)
          for (let x = bounds.minX; x <= bounds.maxX; x += step) {
            const c = { x: snap(x, step), z: snap(z, step), rot };
            const score =
              def.placeable.type === 'lamp' && pots.length > 0
                ? Math.min(...pots.map((p) => distance(p, c)))
                : 0;
            candidates.push({ ...c, score });
          }
      }
      candidates.sort((a, b) => a.score - b.score);
      const found = candidates.find((c) => {
        const r = checkPlacement(data, { ...ctx, fixtures: placed }, { itemId, ...c });
        if (!r.ok) return false;
        if (!isSolidFixture(r.fixture)) return true;
        const wide = expandRect(fixtureRect(r.fixture), gap);
        return !placed.some((f) => isSolidFixture(f) && rectsOverlap(fixtureRect(f), wide));
      });
      if (!found) break;
      const pos = { x: found.x, z: found.z, rot: found.rot };
      out.push({ itemId, ...pos });
      placed.push(furnitureFixture({ id: `gen_${placed.length}`, itemId, ...pos }, data.items)!);
    }
  }
  return out;
}
