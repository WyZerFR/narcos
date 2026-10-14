import type { Color } from 'three';
import {
  FixtureTypeSchema,
  furnitureFixture,
  gameData,
  rotateOffset,
  rotatedSize,
  type Fixture,
  type FixtureType,
} from '@narco/shared';
import { shade } from '../city/batch';

/**
 * Mobilier du labo décrit en boîtes (centre, taille, couleur) : tous les meubles posés sont
 * rendus par 2 `InstancedMesh` de cubes unitaires (opaque + lumineux), quel que soit leur
 * nombre. Boîtes décrites dans le repère du meuble, puis tournées (quarts de tour) et placées.
 * Couleurs dérivées de la palette uniquement.
 */

export interface PartBox {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  color: Color;
}

export interface FixtureParts {
  solid: PartBox[];
  glow: PartBox[];
}

/** Boîte posée au sol (y = base), comme `Batch.block`. */
function block(
  out: PartBox[],
  x: number,
  baseY: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  color: Color,
) {
  out.push({ x, y: baseY + sy / 2, z, sx, sy, sz, color });
}

/** Boîte centrée, comme `Batch.box`. */
function box(
  out: PartBox[],
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  color: Color,
) {
  out.push({ x, y, z, sx, sy, sz, color });
}

/** Meuble posé. `neon` : couleur néon du lieu (lampes). */
export function installedParts(f: Fixture, neon: string): FixtureParts {
  const local = localParts(f.accepts, rotatedSize(f.size, f.rot), neon);
  const place = (b: PartBox): PartBox => {
    const o = rotateOffset(b.x, b.z, f.rot);
    const odd = f.rot % 2 === 1;
    return {
      ...b,
      x: f.position.x + o.x,
      z: f.position.z + o.z,
      sx: odd ? b.sz : b.sx,
      sz: odd ? b.sx : b.sz,
    };
  };
  return { solid: local.solid.map(place), glow: local.glow.map(place) };
}

/** Boîtes d'un meuble dans son repère (centre en 0, empreinte `w` × `d` avant rotation). */
function localParts(type: FixtureType, size: { w: number; d: number }, neon: string): FixtureParts {
  const { palette } = gameData.config;
  const x = 0;
  const z = 0;
  const { w, d } = size;
  const wood = shade(palette.neon, 0.42);
  const solid: PartBox[] = [];
  const glow: PartBox[] = [];
  switch (type) {
    case 'pot':
      // pot en terre cuite, rebord, terreau
      block(solid, x, 0, z, w * 0.8, 0.55, d * 0.8, shade(palette.neon, 0.5));
      block(solid, x, 0.55, z, w * 0.9, 0.1, d * 0.9, shade(palette.neon, 0.6));
      block(solid, x, 0.6, z, w * 0.75, 0.06, d * 0.75, shade(palette.ground, 0.35));
      break;
    case 'drying_rack':
      // deux montants et trois fils tendus
      for (const sx of [-1, 1]) block(solid, x + (sx * w) / 2, 0, z, 0.1, 2.1, 0.1, wood);
      for (const y of [1.3, 1.65, 2])
        block(solid, x, y, z, w, 0.03, 0.03, shade(palette.ground, 2));
      break;
    case 'cutting_table':
      // plateau, pieds, planche à découper, balance, lampe de bureau
      block(solid, x, 0.82, z, w, 0.08, d, wood);
      for (const sx of [-1, 1])
        for (const sz of [-1, 1])
          block(
            solid,
            x + sx * (w / 2 - 0.1),
            0,
            z + sz * (d / 2 - 0.1),
            0.08,
            0.82,
            0.08,
            shade(palette.neon, 0.3),
          );
      block(solid, x - w * 0.15, 0.9, z, w * 0.4, 0.04, d * 0.6, shade(palette.neon, 0.75));
      block(solid, x + w * 0.3, 0.9, z, 0.35, 0.08, 0.3, shade(palette.ground, 2));
      box(glow, x + w * 0.3, 1.45, z - d * 0.3, 0.3, 0.08, 0.2, shade(palette.neon, 1.1));
      break;
    case 'lamp':
      // lampe de culture suspendue au plafond : câble, cadre fin, panneau lumineux visible d'en
      // haut, et flaque de lumière au sol (émissive, pas de vraie lumière)
      block(solid, x, 2.1, z, 0.04, 1.4, 0.04, shade(palette.sky, 0.5));
      block(solid, x, 1.98, z, w + 0.08, 0.04, d + 0.08, shade(palette.sky, 0.8));
      box(glow, x, 2.04, z, w, 0.06, d, shade(neon, 1.1));
      box(glow, x, 0.012, z, w * 2.6, 0.01, d * 2.6, shade(neon, 0.14));
      break;
  }
  return { solid, glow };
}

/** Pièces d'un objet posable à une position donnée (fantôme du mode placement). */
export function partsFor(itemId: string, x: number, z: number, rot: number, neon: string) {
  const f = furnitureFixture({ id: 'ghost', itemId, x, z, rot }, gameData.items);
  return f ? installedParts(f, neon) : { solid: [], glow: [] };
}

/** Nombre maximal de boîtes : plafond de chaque type × boîtes d'un meuble de ce type. */
export function maxParts(neon: string): { solid: number; glow: number } {
  const { maxPerType } = gameData.economy.lab.furniture;
  let solid = 0;
  let glow = 0;
  for (const type of FixtureTypeSchema.options) {
    const parts = localParts(type, { w: 1, d: 1 }, neon);
    solid += parts.solid.length * maxPerType[type];
    glow += parts.glow.length * maxPerType[type];
  }
  return { solid: Math.max(1, solid), glow: Math.max(1, glow) };
}
