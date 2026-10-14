import { distance, rectFromCenter, type Rect, type Vec2 } from './geometry';
import type { Economy, Fixture, FixtureType, Interior, Station } from './schemas';

/**
 * Emplacements aménageables du labo : vides au départ, on y installe du mobilier acheté au
 * Bricoshop. Un emplacement installé se comporte comme un poste (pot, étendoir, table) ; une
 * lampe n'a pas d'action mais accélère les pots à sa portée.
 */

/** Type de poste équivalent à un emplacement installé. */
export const FIXTURE_STATION_KIND: Record<FixtureType, Station['kind']> = {
  pot: 'pot',
  drying_rack: 'rack',
  cutting_table: 'table',
  lamp: 'lamp',
};

/** Les lampes pendent au plafond : elles ne bloquent pas le passage. */
export const isSolidFixture = (f: Fixture) => f.accepts !== 'lamp';

/** Poste correspondant à un emplacement installé. */
export function fixtureStation(f: Fixture, label = f.label): Station {
  return {
    id: f.id,
    kind: FIXTURE_STATION_KIND[f.accepts],
    label,
    position: f.position,
    size: f.size,
    interactRadius: f.interactRadius,
    solid: isSolidFixture(f),
  };
}

/** Obstacles ajoutés par les emplacements installés (hors lampes). */
export function fixtureObstacles(interior: Interior, installed: ReadonlySet<string>): Rect[] {
  return interior.fixtures
    .filter((f) => installed.has(f.id) && isSolidFixture(f))
    .map((f) => rectFromCenter(f.position, f.size));
}

/**
 * Vitesse de pousse d'un pot selon les lampes installées à portée : la durée est multipliée
 * par `1 − min(n, max) × réduction`, donc la vitesse par l'inverse.
 */
export function lampRate(pot: Vec2, lamps: readonly Vec2[], rules: Economy['lab']['lamp']): number {
  const n = Math.min(rules.maxLamps, lamps.filter((l) => distance(l, pot) <= rules.range).length);
  return 1 / (1 - n * rules.growReductionPerLamp);
}

/** Un endroit avec lequel interagir dans un intérieur : poste fixe ou emplacement. */
export interface Place {
  id: string;
  position: Vec2;
  interactRadius: number;
  /** Présent si c'est un emplacement aménageable. */
  fixture?: Fixture;
  /** Poste actif : poste fixe, ou emplacement installé. */
  station?: Station;
}

/** Postes fixes + emplacements (installés → poste, vides → emplacement à équiper). */
export function interiorPlaces(interior: Interior, installed: ReadonlySet<string>): Place[] {
  return [
    ...interior.stations.map((st) => ({
      id: st.id,
      position: st.position,
      interactRadius: st.interactRadius,
      station: st,
    })),
    ...interior.fixtures.map((f) => ({
      id: f.id,
      position: f.position,
      interactRadius: f.interactRadius,
      fixture: f,
      ...(installed.has(f.id) ? { station: fixtureStation(f) } : {}),
    })),
  ];
}

/** Endroit le plus proche dont le rayon d'interaction contient `pos`. */
export function nearestPlace(pos: Vec2, places: readonly Place[], tolerance = 0): Place | null {
  let best: Place | null = null;
  let bestDist = Infinity;
  for (const p of places) {
    const d = distance(pos, p.position);
    if (d <= p.interactRadius + tolerance && d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return best;
}
