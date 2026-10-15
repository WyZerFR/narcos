import { distance, rectFromCenter, type Rect, type Vec2 } from './geometry';
import type { Economy, FixtureType, Interior, ItemDef, Placeable, Station } from './schemas';

/**
 * Meubles posés librement dans le labo (achetés au Bricoshop) : un meuble posé se comporte
 * comme un poste (pot, étendoir, table) ; une lampe n'a pas d'action mais accélère les pots
 * à sa portée. L'état serveur ne garde que { id, objet, position, rotation } : tout le reste
 * (empreinte, portée, type) vient de `items.json`.
 */

/** Meuble tel qu'enregistré (état serveur, snapshot). `rot` = quarts de tour (0..3). */
export interface Furniture {
  id: string;
  itemId: string;
  x: number;
  z: number;
  rot: number;
}

/** Meuble posé, résolu avec sa fiche `placeable`. `size` = empreinte au sol après rotation. */
export interface Fixture {
  id: string;
  itemId: string;
  accepts: FixtureType;
  label: string;
  position: Vec2;
  size: { w: number; d: number };
  rot: number;
  interactRadius: number;
  mount: Placeable['mount'];
  height: number;
}

export interface ItemSource {
  get(id: string): ItemDef | undefined;
}

/** Type de poste équivalent à un meuble posé. */
export const FIXTURE_STATION_KIND: Record<FixtureType, Station['kind']> = {
  pot: 'pot',
  drying_rack: 'rack',
  cutting_table: 'table',
  lamp: 'lamp',
};

/** Quart de tour normalisé (0..3). */
export const normRot = (rot: number) => ((Math.round(rot) % 4) + 4) % 4;

/** Empreinte au sol d'une fiche après `rot` quarts de tour (largeur et profondeur échangées). */
export function rotatedSize(p: Pick<Placeable, 'w' | 'd'>, rot: number): { w: number; d: number } {
  return normRot(rot) % 2 === 0 ? { w: p.w, d: p.d } : { w: p.d, d: p.w };
}

/** Décalage local (x, z) d'un meuble tourné de `rot` quarts de tour (rotation Y de three.js). */
export function rotateOffset(x: number, z: number, rot: number): Vec2 {
  switch (normRot(rot)) {
    case 1:
      return { x: z, z: -x };
    case 2:
      return { x: -x, z: -z };
    case 3:
      return { x: -z, z: x };
    default:
      return { x, z };
  }
}

/** Meuble résolu (null si l'objet n'est pas posable). */
export function furnitureFixture(f: Furniture, items: ItemSource): Fixture | null {
  const def = items.get(f.itemId);
  const p = def?.placeable;
  if (!def || !p) return null;
  return {
    id: f.id,
    itemId: f.itemId,
    accepts: p.type,
    label: def.name,
    position: { x: f.x, z: f.z },
    size: rotatedSize(p, f.rot),
    rot: normRot(f.rot),
    interactRadius: p.interactRadius,
    mount: p.mount,
    height: p.height,
  };
}

export function furnitureFixtures(list: Iterable<Furniture>, items: ItemSource): Fixture[] {
  const out: Fixture[] = [];
  for (const f of list) {
    const fx = furnitureFixture(f, items);
    if (fx) out.push(fx);
  }
  return out;
}

/** Les lampes pendent au plafond : elles ne bloquent pas le passage. */
export const isSolidFixture = (f: Pick<Fixture, 'mount'>) => f.mount === 'floor';

/** Rectangle au sol d'un meuble. */
export const fixtureRect = (f: Pick<Fixture, 'position' | 'size'>): Rect =>
  rectFromCenter(f.position, f.size);

/** Poste correspondant à un meuble posé. */
export function fixtureStation(f: Fixture): Station {
  return {
    id: f.id,
    kind: FIXTURE_STATION_KIND[f.accepts],
    label: f.label,
    position: f.position,
    size: f.size,
    interactRadius: f.interactRadius,
    solid: isSolidFixture(f),
  };
}

/** Obstacles ajoutés par les meubles posés (hors lampes). */
export function fixtureObstacles(fixtures: readonly Fixture[]): Rect[] {
  return fixtures.filter(isSolidFixture).map(fixtureRect);
}

/**
 * Vitesse de pousse d'un pot selon les lampes posées à portée : la durée est multipliée
 * par `1 − min(n, max) × réduction`, donc la vitesse par l'inverse.
 */
export function lampRate(pot: Vec2, lamps: readonly Vec2[], rules: Economy['lab']['lamp']): number {
  const n = Math.min(rules.maxLamps, lamps.filter((l) => distance(l, pot) <= rules.range).length);
  return 1 / (1 - n * rules.growReductionPerLamp);
}

/** Refus : planter (ou sortir un pot planté de la lumière) sans lampe à portée. */
export const NO_LAMP = 'Il faut une lampe à portée du pot.';
/** Refus : reprendre ou éloigner la dernière lampe d'un pot planté. */
export const LAMP_IN_USE = 'Une plante pousse sous cette lampe.';

/** Le pot a-t-il au moins une lampe à portée (`economy.lab.lamp.range`, distance au sol) ? */
export function potLit(pot: Vec2, lamps: readonly Vec2[], range: number): boolean {
  return lamps.some((l) => distance(l, pot) <= range);
}

/** Pots plantés sans lampe à portée, pour un agencement donné des meubles. */
export function unlitPlantedPots(
  fixtures: readonly Fixture[],
  isPlanted: (potId: string) => boolean,
  range: number,
): string[] {
  const lamps = fixtures.filter((f) => f.accepts === 'lamp').map((f) => f.position);
  return fixtures
    .filter((f) => f.accepts === 'pot' && isPlanted(f.id) && !potLit(f.position, lamps, range))
    .map((f) => f.id);
}

/** Un endroit avec lequel interagir dans un intérieur : poste fixe ou meuble posé. */
export interface Place {
  id: string;
  position: Vec2;
  interactRadius: number;
  station: Station;
  /** Présent si c'est un meuble posé (déplaçable, reprenable). */
  fixture?: Fixture;
}

/** Postes fixes de l'intérieur + meubles posés. */
export function interiorPlaces(interior: Interior, fixtures: readonly Fixture[]): Place[] {
  return [
    ...interior.stations.map((st) => ({
      id: st.id,
      position: st.position,
      interactRadius: st.interactRadius,
      station: st,
    })),
    ...fixtures.map((f) => ({
      id: f.id,
      position: f.position,
      interactRadius: f.interactRadius,
      station: fixtureStation(f),
      fixture: f,
    })),
  ];
}

/** Endroit le plus proche dont le rayon d'interaction contient `pos`. */
export function nearestPlace(pos: Vec2, places: readonly Place[], tolerance = 0): Place | null {
  // Les meubles au plafond (lampes, sans action) ne passent qu'à défaut : une lampe posée
  // au-dessus d'un pot, même plus proche du joueur, ne lui masque jamais le pot.
  let best: Place | null = null;
  let bestDist = Infinity;
  for (const p of places) {
    const d = distance(pos, p.position);
    if (d > p.interactRadius + tolerance) continue;
    const ceiling = p.fixture?.mount === 'ceiling';
    const bestCeiling = best?.fixture?.mount === 'ceiling';
    if (best && ceiling && !bestCeiling) continue;
    if (!best || (bestCeiling && !ceiling) || d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return best;
}
