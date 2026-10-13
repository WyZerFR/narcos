import { useSyncExternalStore } from 'react';
import { gameData, type CameraConfig } from '@narco/shared';

/**
 * Réglages caméra courants. Valeurs initiales lues dans `config.json` ; le panneau debug
 * les modifie en direct (rien n'est persisté : on recopie le JSON dans config.json).
 */
let current: CameraConfig = { ...gameData.config.camera };
const listeners = new Set<() => void>();

export function getCamera(): CameraConfig {
  return current;
}

export function updateCamera(patch: Partial<CameraConfig>): void {
  current = { ...current, ...patch };
  for (const fn of listeners) fn();
}

export function resetCamera(): void {
  updateCamera({ ...gameData.config.camera });
}

export function useCamera(): CameraConfig {
  return useSyncExternalStore((fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, getCamera);
}

const DEG = Math.PI / 180;

/** Décalage caméra → cible pour une élévation/rotation/distance données. */
export function cameraOffset(c: CameraConfig): { x: number; y: number; z: number } {
  const el = c.elevation * DEG;
  const rot = c.rotation * DEG;
  return {
    x: Math.sin(rot) * Math.cos(el) * c.zoom,
    y: Math.sin(el) * c.zoom,
    z: Math.cos(rot) * Math.cos(el) * c.zoom,
  };
}

/** Hauteur visible (m) en ortho, équivalente à la perspective au même zoom et FOV. */
export function orthoViewHeight(c: CameraConfig): number {
  return 2 * c.zoom * Math.tan((c.fov * DEG) / 2);
}

/**
 * Convertit une direction écran (x = droite, y = haut) en direction monde selon la rotation
 * de la caméra, pour que « haut du joystick » parte toujours vers le haut de l'écran.
 */
export function screenToWorld(x: number, y: number): { x: number; z: number } {
  const rot = current.rotation * DEG;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  return { x: x * cos - y * sin, z: -x * sin - y * cos };
}
