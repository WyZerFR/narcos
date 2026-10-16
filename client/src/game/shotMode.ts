import { gameData, obstaclesFrom, shotTarget, type Vec2 } from '@narco/shared';

/**
 * Mode debug `?shot=<area>` : la caméra de jeu se pose à un point de vue fixe sur l'area
 * (`config.debugShot`), qui est aussi chargée, pour comparer avec l'image de référence.
 */
const param =
  typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('shot');
let cached: Vec2 | null | undefined;

/** Point visé par le mode shot, ou null hors de ce mode (ou area inconnue). */
export function getShot(): Vec2 | null {
  if (cached === undefined)
    cached = param ? shotTarget(gameData, param, obstaclesFrom(gameData)) : null;
  return cached;
}
