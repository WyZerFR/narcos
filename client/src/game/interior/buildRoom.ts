import type { BufferGeometry } from 'three';
import { gameData, type GameData, type Interior } from '@narco/shared';
import { Batch, shade } from '../city/batch';

/** Épaisseur des murs (style de modélisation, hors des bornes de déplacement). */
const WALL = 0.3;

export interface RoomGeometry {
  solid: BufferGeometry;
  glow: BufferGeometry;
}

/**
 * Pièce intérieure fusionnée en 2 géométries (comme la ville) : sol, murs, porte.
 * Couleurs dérivées du lieu d'entrée (`color` / `neonColor`) et de la palette.
 */
export function buildRoom(interior: Interior, data: GameData = gameData): RoomGeometry {
  const { palette } = data.config;
  const entrance = data.locations.get(interior.entranceLocationId)!;
  const solid = new Batch();
  const glow = new Batch();
  const { w, d } = interior.size;
  const h = interior.wallHeight;
  const wall = shade(entrance.color, 1.15);

  // sol carrelé en damier (deux tons du sol de la palette)
  solid.floor(
    { minX: -w / 2 - WALL, maxX: w / 2 + WALL, minZ: -d / 2 - WALL, maxZ: d / 2 + WALL },
    0,
    shade(palette.ground, 0.9),
  );
  for (let x = -w / 2; x < w / 2; x += 1) {
    for (let z = -d / 2; z < d / 2; z += 1) {
      if ((Math.round(x) + Math.round(z)) % 2 === 0) continue;
      solid.floor(
        { minX: x, maxX: x + 1, minZ: z, maxZ: z + 1 },
        0.005,
        shade(palette.ground, 1.25),
      );
    }
  }

  // murs (percés par la découpe quand ils cachent le joueur) + plinthe
  const walls = [
    { x: 0, z: -d / 2 - WALL / 2, sx: w + WALL * 2, sz: WALL },
    { x: 0, z: d / 2 + WALL / 2, sx: w + WALL * 2, sz: WALL },
    { x: -w / 2 - WALL / 2, z: 0, sx: WALL, sz: d },
    { x: w / 2 + WALL / 2, z: 0, sx: WALL, sz: d },
  ];
  for (const wl of walls) {
    solid.block(wl.x, 0, wl.z, wl.sx, h, wl.sz, wall);
    solid.block(wl.x, 0, wl.z, wl.sx + 0.06, 0.25, wl.sz + 0.06, shade(entrance.color, 0.6));
  }

  // porte de sortie : encadrement + lueur de la rue
  const exit = interior.stations.find((s) => s.kind === 'exit');
  if (exit) {
    const ex = exit.position.x;
    const ez = d / 2;
    solid.block(ex, 0, ez, exit.size.w + 0.3, 2.5, WALL + 0.1, shade(palette.sky, 0.5));
    glow.box(ex, 1.2, ez - WALL / 2 - 0.02, exit.size.w, 2.3, 0.04, shade(palette.neon, 0.8));
  }

  return { solid: solid.build(), glow: glow.build() };
}
