import {
  footprint,
  rectFromCenter,
  visibleLocations,
  type DoorSide,
  type GameData,
  type Rect,
} from '@narco/shared';
import { faceOf } from './batch';

/** Un halo additif plaqué devant une façade (enseigne, devanture, gyrophare). */
export interface Halo {
  x: number;
  y: number;
  z: number;
  /** Orientation (rad) : le quad regarde dans le sens de la normale de la façade. */
  ry: number;
  size: number;
  color: string;
  /** Clignotement (Hz) ; 0 = fixe. */
  blinkHz: number;
  phase: number;
}

/** Décollement du halo devant la façade (m), pour passer devant enseignes et auvents. */
const OUT = 0.45;

/**
 * Halos des devantures : lieux visibles avec porte (néon du lieu) et blocs à enseigne ;
 * gyrophares du commissariat (clignotants, alternés). Aucune lumière : des quads instanciés.
 * Jamais pour un lieu caché (trappe) ni pour les jardins des quartiers.
 */
export function haloPlacements(data: GameData): Halo[] {
  const { halo } = data.config.render;
  const out: Halo[] = [];
  const front = (
    r: Rect,
    side: DoorSide,
    y: number,
    size: number,
    color: string,
    u = 0,
    blinkHz = 0,
    phase = 0,
  ) => {
    const f = faceOf(r, side);
    out.push({
      x: f.cx + f.ux * u + f.nx * OUT,
      y,
      z: f.cz + f.uz * u + f.nz * OUT,
      ry: Math.atan2(f.nx, f.nz),
      size,
      color,
      blinkHz,
      phase,
    });
  };
  for (const loc of visibleLocations(data.locations.values())) {
    if (loc.kind !== 'building' || !loc.door) continue;
    front(footprint(loc), loc.door, Math.min(loc.height - 0.8, 3.4), halo.size, loc.neonColor);
  }
  for (const b of data.blocks) {
    if (!b.door || !b.neonColor || !b.sign) continue;
    const r = rectFromCenter(b.position, b.size);
    front(r, b.door, Math.min(b.height - 0.6, 3.6), halo.size, b.neonColor);
    if (b.style !== 'police') continue;
    // gyrophares sur le toit, au bord de la façade : rouge et bleu en opposition de phase
    const f = faceOf(r, b.door);
    halo.beaconColors.forEach((color, i) => {
      const u = (i / Math.max(1, halo.beaconColors.length - 1) - 0.5) * f.len * 0.5;
      front(r, b.door!, b.height + 0.7, halo.beaconSize, color, u, halo.beaconHz, i * Math.PI);
    });
  }
  return out;
}
