import { useSyncExternalStore } from 'react';
import { areaAt, areaNeighbors, gameData, nearestArea, type Vec2 } from '@narco/shared';
import { localPlayer } from './localPlayer';

/**
 * Chargement par area : l'area du joueur local et ses voisines directes sont rendues, le reste
 * de l'île est masqué (géométries construites une fois, aucun à-coup au changement d'area).
 * Lu par la ville, le décor instancié et les étiquettes.
 */

const AREAS = [...gameData.areas.values()];
const NEIGHBORS = areaNeighbors(AREAS);
const POLL_MS = 250;

let current = '';
let loaded = new Set<string>(AREAS.map((a) => a.id));
const listeners = new Set<() => void>();

function refresh() {
  if (!localPlayer.initialized) return;
  const id = areaAt(AREAS, localPlayer)?.id;
  if (!id || id === current) return;
  current = id;
  loaded = new Set([id, ...(NEIGHBORS.get(id) ?? [])]);
  for (const l of listeners) l();
}

let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(cb: () => void) {
  listeners.add(cb);
  timer ??= setInterval(refresh, POLL_MS);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Areas chargées (même objet tant qu'elles ne changent pas). */
export function useLoadedAreas(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => loaded);
}

/** Area courante du joueur local ('' avant la première position). */
export function currentArea(): string {
  return current;
}

/** Area rattachée à un point fixe (étiquettes : calculée une fois, pas à chaque image). */
export function areaIdNear(p: Vec2): string {
  return nearestArea(AREAS, p)?.id ?? '';
}

/** L'area est-elle chargée ? (hors de la boucle React) */
export function isAreaLoaded(areaId: string): boolean {
  return areaId === '' || loaded.has(areaId);
}
