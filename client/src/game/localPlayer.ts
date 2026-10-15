import { gameData, inInteractRange, STREET } from '@narco/shared';

/**
 * Position prédite du joueur local (mutable, hors React). Le serveur reste l'autorité :
 * à la (re)connexion ou au changement de zone on repart de sa position, et un message
 * `correction` nous recale.
 */
export const localPlayer = {
  initialized: false,
  /** Zone dans laquelle `x`/`z` sont exprimés (rue ou intérieur). */
  zone: STREET as string,
  x: 0,
  z: 0,
  rotY: 0,
  seq: 0,
};

/**
 * Le joueur local est-il encore dans la zone et dans le rayon de sortie du poste (hystérésis) ?
 * Garde un panneau (dialogue, blanchiment) ouvert tant qu'on reste au comptoir.
 */
export function stillAt(zone: string, stationId: string): boolean {
  if (localPlayer.zone !== zone) return false;
  const station = gameData.interiors.get(zone)?.stations.find((s) => s.id === stationId);
  if (!station) return true;
  return inInteractRange(localPlayer, station, true, gameData.config.world.interactExitMargin);
}

export function resetLocalPlayer(): void {
  localPlayer.initialized = false;
}
