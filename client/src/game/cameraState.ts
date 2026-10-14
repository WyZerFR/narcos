import { useSyncExternalStore } from 'react';
import { gameData, type CameraConfig } from '@narco/shared';

/**
 * Réglages caméra courants : un jeu pour la rue (`config.camera`), un pour les intérieurs
 * (`config.cameraInterior`). Le panneau debug règle celui de la zone où l'on se trouve
 * (rien n'est persisté : on recopie le JSON dans config.json).
 */
export type CameraKind = 'street' | 'interior';

const cams: Record<CameraKind, CameraConfig> = {
  street: { ...gameData.config.camera },
  interior: { ...gameData.config.cameraInterior },
};
const DEFAULTS: Record<CameraKind, CameraConfig> = {
  street: gameData.config.camera,
  interior: gameData.config.cameraInterior,
};
let active: CameraKind = 'street';
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function getCamera(): CameraConfig {
  return cams[active];
}

export function getCameraKind(): CameraKind {
  return active;
}

/** Les deux jeux de réglages (pour l'export JSON du panneau). */
export function getCameraConfigs(): Readonly<Record<CameraKind, CameraConfig>> {
  return cams;
}

export function setCameraKind(kind: CameraKind): void {
  if (kind === active) return;
  active = kind;
  emit();
}

export function updateCamera(patch: Partial<CameraConfig>): void {
  cams[active] = { ...cams[active], ...patch };
  emit();
}

export function resetCamera(): void {
  cams[active] = { ...DEFAULTS[active] };
  emit();
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
  const rot = getCamera().rotation * DEG;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  return { x: x * cos - y * sin, z: -x * sin - y * cos };
}
