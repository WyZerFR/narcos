import type { Vec2 } from './geometry';
import type { CameraConfig, Interior } from './schemas';

/**
 * Cadrage de la caméra dans un intérieur : la pièce entière (murs compris) doit tenir à l'écran,
 * quelle que soit sa taille (`layoutScale`). Logique pure, sans Three.js.
 */

export interface InteriorFraming {
  /** Part du déplacement du joueur suivie par la caméra (0 = centre de la pièce fixe, 1 = joueur). */
  followFraction: number;
  /** Marge (m) autour de la pièce. */
  margin: number;
}

const DEG = Math.PI / 180;

/**
 * Distance caméra minimale pour voir toute la pièce (centrée en 0,0) avec cette élévation, ce
 * champ et ce rapport largeur/hauteur. Projection de l'emprise au sol (tournée selon la
 * caméra) et de la hauteur des murs sur le plan de vue.
 */
export function fitInteriorZoom(
  interior: Pick<Interior, 'size' | 'wallHeight'>,
  cam: Pick<CameraConfig, 'elevation' | 'rotation' | 'fov'>,
  aspect: number,
  framing: InteriorFraming,
): number {
  const el = cam.elevation * DEG;
  const rot = cam.rotation * DEG;
  const { w, d } = interior.size;
  const across = Math.abs(w * Math.cos(rot)) + Math.abs(d * Math.sin(rot));
  const depth = Math.abs(w * Math.sin(rot)) + Math.abs(d * Math.cos(rot));
  const tan = Math.tan((cam.fov * DEG) / 2);
  // part du déplacement suivie : la pièce peut se décaler de cette fraction de sa demi-taille
  const slack = 1 + framing.followFraction;
  const vertical =
    depth * slack * Math.sin(el) + interior.wallHeight * Math.cos(el) + 2 * framing.margin;
  const horizontal = across * slack + 2 * framing.margin;
  return Math.max(vertical / (2 * tan), horizontal / (2 * tan * Math.max(aspect, 1e-3)));
}

/** Point visé par la caméra : entre le centre de la pièce et le joueur. */
export function interiorCameraTarget(player: Vec2, framing: InteriorFraming): Vec2 {
  return { x: player.x * framing.followFraction, z: player.z * framing.followFraction };
}
