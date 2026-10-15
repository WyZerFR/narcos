import { obstaclesFrom, type MapData } from './collision';
import { nearestPlace, type Place } from './fixtures';
import type { GameData } from './data';
import { distance, rectFromCenter, type Rect, type Vec2 } from './geometry';
import type { GameLocation, Interior, Station } from './schemas';

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
    ...interior.props.filter((p) => p.solid).map((p) => rectFromCenter(p.position, p.size)),
  ];
}

export interface ZoneArea {
  bounds: Rect;
  obstacles: Rect[];
}

/** Bornes + obstacles de la zone (rue ou intérieur). `null` si la zone est inconnue. */
export function zoneArea(
  data: MapData & Pick<GameData, 'interiors'>,
  zoneId: string,
  /** Obstacles dynamiques en plus (mobilier installé). */
  extra: readonly Rect[] = [],
): ZoneArea | null {
  if (zoneId === STREET)
    return { bounds: data.config.world.bounds, obstacles: obstaclesFrom(data) };
  const interior = data.interiors.get(zoneId);
  return interior
    ? { bounds: interiorBounds(interior), obstacles: [...interiorObstacles(interior), ...extra] }
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

/** Ce que fait le bouton ACTION devant un lieu de la rue : entrer, parler, ou rien (repère). */
export type LocationInteraction = 'enter' | 'talk';

/**
 * Interaction d'un lieu : `enter` s'il mène à un intérieur, `talk` s'il porte un dialogue,
 * null sinon (ruelle, point relais… : simple repère, aucun bouton ACTION).
 */
export function locationInteraction(
  data: Pick<GameData, 'interiors'>,
  loc: Pick<GameLocation, 'id' | 'dialogue'>,
): LocationInteraction | null {
  if (interiorForLocation(data, loc.id)) return 'enter';
  if (loc.dialogue) return 'talk';
  return null;
}

/**
 * Hystérésis d'interaction : on entre dans le rayon d'un poste à `interactRadius`, on n'en sort
 * qu'à `interactRadius + exitMargin` (bouton ACTION qui ne clignote pas, panneaux qui restent
 * ouverts à la limite du rayon).
 */
export function inInteractRange(
  pos: Vec2,
  target: { position: Vec2; interactRadius: number },
  wasInside: boolean,
  exitMargin: number,
): boolean {
  return distance(pos, target.position) <= target.interactRadius + (wasInside ? exitMargin : 0);
}

/** Endroit visé avec hystérésis : `currentId` reste choisi tant qu'on est dans son rayon de sortie. */
export function stickyNearest(
  pos: Vec2,
  places: readonly Place[],
  currentId: string | null,
  exitMargin: number,
): Place | null {
  const current = currentId ? places.find((p) => p.id === currentId) : undefined;
  if (current && inInteractRange(pos, current, true, exitMargin)) return current;
  return nearestPlace(pos, places);
}
