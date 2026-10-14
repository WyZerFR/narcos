import {
  fixtureObstacles,
  gameData,
  interiorPlaces,
  STREET,
  zoneArea,
  type Fixture,
  type Place,
  type ZoneArea,
} from '@narco/shared';
import type { GameRoom } from '../net/connection';
import { readFixtures } from '../net/gameView';

/**
 * Mobilier installé du labo vu par le client : ensemble des emplacements équipés, zone de
 * collisions correspondante (même calcul que le serveur) et endroits interactifs.
 */

export function installedSet(room: GameRoom): Set<string> {
  return new Set(readFixtures(room).keys());
}

const keyOf = (installed: ReadonlySet<string>) => [...installed].sort().join(',');

const areaCache = new Map<string, ZoneArea>();

/** Bornes + obstacles de la zone, mobilier installé compris (mis en cache par configuration). */
export function areaFor(zoneId: string, installed: ReadonlySet<string>): ZoneArea | null {
  const interior = gameData.interiors.get(zoneId);
  const key = `${zoneId}|${interior?.fixtures.length ? keyOf(installed) : ''}`;
  const cached = areaCache.get(key);
  if (cached) return cached;
  const area =
    zoneId === STREET || !interior
      ? zoneArea(gameData, zoneId)
      : zoneArea(gameData, zoneId, fixtureObstacles(interior, installed));
  if (area) areaCache.set(key, area);
  return area;
}

/** Postes fixes + emplacements de l'intérieur, avec leur état installé. */
export function placesOf(zoneId: string, installed: ReadonlySet<string>): Place[] {
  const interior = gameData.interiors.get(zoneId);
  return interior ? interiorPlaces(interior, installed) : [];
}

/** Objet du sac compatible avec un emplacement (premier trouvé). */
export function compatibleItem(
  bag: readonly ({ itemId: string } | null)[],
  fixture: Fixture,
): string | null {
  for (const s of bag)
    if (s && gameData.items.get(s.itemId)?.installs === fixture.accepts) return s.itemId;
  return null;
}

/** Objet vendu au Bricoshop pour un type d'emplacement (pour le libellé d'aide). */
export function itemNameFor(fixture: Fixture): string {
  const item = [...gameData.items.values()].find((it) => it.installs === fixture.accepts);
  return item?.name ?? fixture.accepts;
}
