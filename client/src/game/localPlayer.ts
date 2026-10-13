/**
 * Position prédite du joueur local (mutable, hors React). Le serveur reste l'autorité :
 * à la (re)connexion on repart de sa position, et un message `correction` nous recale.
 */
export const localPlayer = {
  initialized: false,
  x: 0,
  z: 0,
  rotY: 0,
  seq: 0,
};

export function resetLocalPlayer(): void {
  localPlayer.initialized = false;
}
