/**
 * État d'entrée partagé, lu à chaque frame par le contrôleur du joueur local.
 * Objet mutable (pas de React) pour ne déclencher aucun rendu à 60 Hz.
 */
export const input = {
  /** Joystick tactile, dans [-1, 1]. y > 0 = vers le haut de l'écran. */
  joyX: 0,
  joyY: 0,
  /** Touches de déplacement enfoncées (clavier). */
  up: false,
  down: false,
  left: false,
  right: false,
  run: false,
  /** Compteur incrémenté à chaque appui sur le bouton d'action. */
  actionPresses: 0,
};

/** Direction écran normalisée (longueur <= 1) + intention de courir. */
export function readMoveIntent(): { x: number; y: number; magnitude: number; run: boolean } {
  let x = input.joyX;
  let y = input.joyY;
  let run = Math.hypot(x, y) > 0.9;

  const kx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const ky = (input.up ? 1 : 0) - (input.down ? 1 : 0);
  if (kx !== 0 || ky !== 0) {
    x = kx;
    y = ky;
    run = input.run;
  }

  const len = Math.hypot(x, y);
  if (len > 1) {
    x /= len;
    y /= len;
  }
  return { x, y, magnitude: Math.min(1, len), run };
}
