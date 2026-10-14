import { useEffect, useState } from 'react';
import type { CutJob, Furniture, Inventory, PotState, RackEntry } from '@narco/shared';
import type { GameRoom, SlotView } from './connection';

/**
 * Lecture de l'état serveur en objets simples pour la logique pure de `shared/`
 * (le client calcule les mêmes statuts que le serveur, sans jamais décider à sa place).
 */

/**
 * Abonnement aux patchs d'état. Attention : dans colyseus.js, `room.onStateChange(cb)` renvoie
 * l'émetteur partagé et son `.clear()` supprime TOUS les abonnés (horloge comprise).
 * On ne retire donc que son propre callback.
 */
export function subscribeState(room: GameRoom, cb: () => void): () => void {
  room.onStateChange(cb);
  return () => room.onStateChange.remove(cb);
}

// ---------------------------------------------------------------- horloge de jeu

const clock = { now: 0, scale: 1, at: 0 };

/** À appeler à chaque patch : mémorise la dernière horloge serveur reçue. */
export function syncClock(room: GameRoom): void {
  const c = room.state.clock;
  if (!c || (c.now === clock.now && c.scale === clock.scale)) return;
  clock.now = c.now;
  clock.scale = c.scale;
  clock.at = Date.now();
}

/** Temps de jeu estimé (ms), extrapolé depuis la dernière diffusion du serveur. */
export function gameNow(): number {
  return clock.at === 0 ? Date.now() : clock.now + (Date.now() - clock.at) * clock.scale;
}

export function gameScale(): number {
  return clock.scale;
}

// ---------------------------------------------------------------- inventaires et labo

const toInventory = (slots: Iterable<SlotView> | undefined): Inventory =>
  slots ? [...slots].map((s) => (s.itemId ? { itemId: s.itemId, qty: s.qty } : null)) : [];

export function readBag(room: GameRoom, playerId: string): Inventory {
  return toInventory(room.state.players?.get(playerId)?.bag);
}

export function readPot(room: GameRoom, stationId: string): PotState | null {
  const p = room.state.lab?.pots?.get(stationId);
  return p
    ? {
        planted: p.planted,
        strainId: p.strainId,
        growMsDone: p.growMsDone,
        bankedAt: p.bankedAt,
        wateredUntil: p.wateredUntil,
        rate: p.rate || 1,
      }
    : null;
}

export function readRack(room: GameRoom, fixtureId: string): RackEntry[] {
  const rack = room.state.lab?.racks?.get(fixtureId)?.entries;
  return rack
    ? [...rack].map((e) => ({ strainId: e.strainId, qty: e.qty, readyAt: e.readyAt }))
    : [];
}

export function readCut(room: GameRoom, fixtureId: string): CutJob | null {
  const c = room.state.lab?.cuts?.get(fixtureId);
  return c?.playerId
    ? { playerId: c.playerId, strainId: c.strainId, qty: c.qty, readyAt: c.readyAt }
    : null;
}

/** Meubles posés dans le labo (id, objet, position, rotation). */
export function readFurniture(room: GameRoom): Furniture[] {
  const out: Furniture[] = [];
  room.state.lab?.fixtures?.forEach((f, id) =>
    out.push({ id, itemId: f.itemId, x: f.x, z: f.z, rot: f.rot }),
  );
  return out;
}

/** Re-rend le composant à chaque patch d'état (pour les panneaux d'inventaire). */
export function useRoomVersion(room: GameRoom | null): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!room) return;
    return subscribeState(room, () => setVersion((v) => v + 1));
  }, [room]);
  return version;
}
