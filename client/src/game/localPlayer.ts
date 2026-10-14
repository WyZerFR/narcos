import { STREET } from '@narco/shared';

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

export function resetLocalPlayer(): void {
  localPlayer.initialized = false;
}
