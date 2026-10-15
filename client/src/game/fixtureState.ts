import {
  fixtureObstacles,
  furnitureFixtures,
  gameData,
  interiorPlaces,
  STREET,
  zoneArea,
  type Fixture,
  type Furniture,
  type Place,
  type ZoneArea,
} from '@narco/shared';
import { useEffect, useState } from 'react';
import type { GameRoom } from '../net/connection';
import { readFurniture, subscribeState } from '../net/gameView';

/**
 * Meubles du labo vus par le client : liste résolue (même calcul que le serveur), zone de
 * collisions correspondante et endroits interactifs. Tout est mis en cache par « signature »
 * (ids + positions + rotations) : recalculé seulement quand un meuble bouge.
 */

export const furnitureSignature = (list: readonly Furniture[]) =>
  list.map((f) => `${f.id}:${f.itemId}:${f.x}:${f.z}:${f.rot}`).join('|');

let cache: { signature: string; fixtures: Fixture[] } = { signature: '', fixtures: [] };

/** Meubles posés du labo (résolus depuis items.json). */
export function labFixtures(room: GameRoom): Fixture[] {
  const list = readFurniture(room);
  const signature = furnitureSignature(list);
  if (signature !== cache.signature)
    cache = { signature, fixtures: furnitureFixtures(list, gameData.items) };
  return cache.fixtures;
}

/** Meubles d'une zone (seul un intérieur aménageable en a). */
export function fixturesFor(room: GameRoom, zoneId: string): Fixture[] {
  return gameData.interiors.get(zoneId)?.furnishable ? labFixtures(room) : [];
}

const areaCache = new Map<string, { fixtures: readonly Fixture[]; area: ZoneArea | null }>();

/** Oublie les obstacles calculés (verrou d'une area changé). */
export function clearAreaCache(): void {
  areaCache.clear();
}

/** Bornes + obstacles de la zone, meubles posés compris (recalculé quand ils bougent). */
export function areaFor(zoneId: string, fixtures: readonly Fixture[]): ZoneArea | null {
  const cached = areaCache.get(zoneId);
  if (cached && cached.fixtures === fixtures) return cached.area;
  const area =
    zoneId === STREET || fixtures.length === 0
      ? zoneArea(gameData, zoneId)
      : zoneArea(gameData, zoneId, fixtureObstacles(fixtures));
  areaCache.set(zoneId, { fixtures, area });
  return area;
}

/** Postes fixes + meubles posés de l'intérieur. */
export function placesOf(zoneId: string, fixtures: readonly Fixture[]): Place[] {
  const interior = gameData.interiors.get(zoneId);
  return interior ? interiorPlaces(interior, fixtures) : [];
}

/** Meubles de la zone pour un composant React : re-rendu seulement quand un meuble change. */
export function useFixtures(room: GameRoom, zoneId: string): Fixture[] {
  const [fixtures, setFixtures] = useState(() => fixturesFor(room, zoneId));
  useEffect(() => {
    const refresh = () => setFixtures(fixturesFor(room, zoneId));
    refresh();
    return subscribeState(room, refresh);
  }, [room, zoneId]);
  return fixtures;
}
