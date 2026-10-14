import type { BufferGeometry } from 'three';
import { gameData, type GameData, type Interior, type Station } from '@narco/shared';
import { Batch, seeded, shade } from '../city/batch';

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
  const wall = shade(entrance.color, 1.6);

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

  // éclairage chaud : bandeau lumineux en haut du mur du fond
  glow.box(0, h - 0.35, -d / 2 + 0.02, w * 0.85, 0.12, 0.08, shade(palette.neon, 1));
  // Mobilier et déco : jamais percés par la découpe (seuls les murs le sont).
  solid.cuttable = false;
  glow.cuttable = false;

  // déco du labo : affiches au mur du fond, étagère à bocaux, seau, vieux canapé
  const isLab = interior.fixtures.length > 0;
  const back = -d / 2 + 0.02;
  if (isLab) {
    glow.box(-w * 0.32, 2.1, back, 1.1, 0.8, 0.04, shade(entrance.neonColor, 0.45));
    glow.box(w * 0.36, 2.2, back, 0.8, 1.1, 0.04, shade(palette.vegetation, 0.6));
    solid.block(-w / 2 + 0.35, 1.6, -d / 4, 0.5, 0.08, 2.2, shade(palette.neon, 0.4));
    for (let i = 0; i < 5; i++) {
      solid.block(
        -w / 2 + 0.35,
        1.68,
        -d / 4 - 0.9 + i * 0.45,
        0.25,
        0.3,
        0.25,
        shade(i % 2 ? palette.vegetation : palette.neon, 0.7),
      );
    }
    solid.block(w / 2 - 1.6, 0, d / 2 - 0.9, 0.5, 0.45, 0.5, shade(palette.wall, 1.5));
    solid.block(-w / 2 + 2.4, 0, d / 2 - 0.7, 2.2, 0.45, 0.8, shade(entrance.neonColor, 0.35));
    solid.block(-w / 2 + 2.4, 0.45, d / 2 - 0.4, 2.2, 0.5, 0.2, shade(entrance.neonColor, 0.3));
  }

  for (const st of interior.stations) buildStation(st, solid, glow, data, entrance.neonColor);

  // la porte fait partie du mur : elle redevient découpable
  solid.cuttable = true;
  glow.cuttable = true;

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

/**
 * Mobilier d'un poste fixe, en blocs. Le mobilier installable du labo (pots, étendoirs, table,
 * lampes) est rendu à part, par instanciation (`FixtureProps`).
 */
function buildStation(st: Station, solid: Batch, glow: Batch, data: GameData, neon: string) {
  const { palette } = data.config;
  const { x, z } = st.position;
  const { w, d } = st.size;
  const wood = shade(palette.neon, 0.42);
  switch (st.kind) {
    case 'water':
      // meuble évier, bac, robinet
      solid.block(x, 0, z, w, 0.85, d, shade(palette.wall, 1.4));
      solid.block(x, 0.85, z, w * 0.75, 0.05, d * 0.7, shade(palette.sky, 2.6));
      solid.block(x - w * 0.35, 0.9, z, 0.08, 0.45, 0.08, shade(palette.ground, 2.2));
      solid.block(x - w * 0.2, 1.3, z, 0.3, 0.06, 0.06, shade(palette.ground, 2.2));
      return;
    case 'stock':
      // grosse caisse en bois, couvercle, cerclages
      solid.block(x, 0, z, w, 0.9, d, wood);
      solid.block(x, 0.9, z, w + 0.06, 0.08, d + 0.06, shade(palette.neon, 0.35));
      for (const sx of [-0.3, 0.3])
        solid.block(x + sx * w, 0, z, 0.08, 0.92, d + 0.04, shade(palette.sky, 0.8));
      return;
    case 'shelf': {
      // étagère murale : montants, fond, trois planches garnies de produits
      const rng = seeded(st.id);
      const shades = [palette.neon, palette.vegetation, neon, palette.ground];
      for (const sx of [-1, 1]) solid.block(x + (sx * w) / 2, 0, z, 0.08, 2, d, wood);
      solid.block(x, 0, z - d / 2 + 0.04, w, 2, 0.06, shade(palette.neon, 0.3));
      for (const y of [0.15, 0.85, 1.55]) {
        solid.block(x, y, z, w, 0.05, d, wood);
        for (let px = -w / 2 + 0.2; px < w / 2 - 0.1; px += 0.28) {
          const c = shades[Math.floor(rng() * shades.length)]!;
          const ph = 0.22 + rng() * 0.2;
          solid.block(x + px, y + 0.05, z + 0.05, 0.2, ph, 0.22, shade(c, 0.7 + rng() * 0.6));
        }
      }
      return;
    }
    case 'counter': {
      // comptoir, caisse enregistreuse à écran lumineux, vendeur derrière (côté mur)
      solid.block(x, 0, z, w, 1, d, shade(palette.wall, 1.5));
      solid.block(x, 1, z, w + 0.1, 0.06, d + 0.1, wood);
      solid.block(x + w * 0.3, 1.06, z, 0.45, 0.25, 0.35, shade(palette.sky, 1.2));
      glow.box(x + w * 0.3, 1.38, z + 0.05, 0.3, 0.16, 0.04, shade(palette.vegetation, 1.6));
      const vz = z - d / 2 - 0.45;
      solid.block(x - w * 0.15, 0, vz, 0.6, 1.4, 0.4, shade(neon, 0.7));
      solid.block(x - w * 0.15, 1.4, vz, 0.42, 0.42, 0.42, shade(palette.ground, 2.3));
      solid.block(x - w * 0.15, 1.82, vz, 0.46, 0.08, 0.46, shade(palette.sky, 0.6));
      return;
    }
    case 'exit':
      return;
  }
}
