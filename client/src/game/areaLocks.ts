import { useEffect, useSyncExternalStore } from 'react';
import { gameData } from '@narco/shared';
import type { GameRoom } from '../net/connection';
import { subscribeState } from '../net/gameView';
import { clearAreaCache } from './fixtureState';

/**
 * Verrou des areas diffusé par le serveur (`areaLocks`) : recopié dans `gameData` (comme le
 * serveur), obstacles de prédiction oubliés, et numéro de version pour reconstruire la ville
 * (portail de l'aéroport ouvert ou fermé).
 */

let version = 0;
const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Applique les verrous reçus ; renvoie la version (change à chaque verrou modifié). */
export function useAreaLocks(room: GameRoom): number {
  useEffect(() => {
    const apply = () => {
      let changed = false;
      room.state.areaLocks?.forEach((locked, id) => {
        const area = gameData.areas.get(id);
        if (area && area.locked !== locked) {
          area.locked = locked;
          changed = true;
        }
      });
      if (!changed) return;
      clearAreaCache();
      version++;
      for (const l of listeners) l();
    };
    apply();
    return subscribeState(room, apply);
  }, [room]);
  return useSyncExternalStore(subscribe, () => version);
}
