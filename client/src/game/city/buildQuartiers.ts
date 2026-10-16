import type { Color } from 'three';
import {
  areaRects,
  type GameData,
  type House,
  type QuartierLayout,
  type QuartierParams,
  type Vec2,
} from '@narco/shared';
import { faceOf, mix, shade, type Batch, type Face } from './batch';

/**
 * Impasses générées (`gameData.quartierLayouts`) fusionnées dans les deux géométries de la
 * ville : sol, maisons, clôtures, arche, gardes, portail, guirlandes. Aucun draw call par
 * maison. Couleurs : palette du quartier (`quartiers.json`) et `config.palette`. Les
 * constantes ci-dessous ne sont que du gabarit de modélisation.
 */

const WIN_W = 0.9;
const WIN_H = 1.1;
const DOOR_W = 1.1;
const DOOR_H = 2.1;
const GARAGE_W = 2.4;
const GARAGE_H = 2.2;
const FLOOR_H = 3;
const ROOF_PITCH = 0.5;
const FENCE_H = 0.9;
const BULB_STEP = 0.8;

interface Batches {
  solid: Batch;
  glow: Batch;
}

/** Mobilier (non percé par la découpe), comme `furniture()` de buildCity. */
function furniture(b: Batches, build: () => void): void {
  b.solid.cuttable = false;
  b.glow.cuttable = false;
  build();
  b.solid.cuttable = true;
  b.glow.cuttable = true;
}

export function buildQuartiers(
  b: Batches,
  data: GameData,
  /** Appelé avant chaque quartier : aiguillage vers les batches de son area. */
  enterArea?: (areaId: string) => void,
): void {
  // hors des areas : la mer, posée par buildCity
  const { palette } = data.config;
  for (const layout of data.quartierLayouts.values()) {
    enterArea?.(layout.areaId);
    const q = data.quartiers.get(layout.id)!;
    ground(b, layout, q, data);
    for (const h of layout.houses) house(b, h, q, palette.sky);
    furniture(b, () => decor(b, layout, q, data));
  }
}

function ground(b: Batches, l: QuartierLayout, q: QuartierParams, data: GameData) {
  const p = q.palette;
  const area = data.areas.get(l.areaId)!;
  b.solid.cuttable = false;
  for (const r of areaRects(area)) b.solid.floor(r, 0.006, shade(p.ground, 1));
  for (const r of l.parking) b.solid.floor(r, 0.021, shade(p.road, 1.35));
  for (const r of l.sidewalks) {
    const cx = (r.minX + r.maxX) / 2;
    const cz = (r.minZ + r.maxZ) / 2;
    b.solid.block(cx, 0, cz, r.maxX - r.minX, 0.12, r.maxZ - r.minZ, shade(p.sidewalk, 1));
  }
  b.solid.floor(l.plaza, 0.03, shade(p.sidewalk, 1.15));
  // chaussées (la traversée du U passe sur la place), marquage central en pointillés néon
  for (const road of l.roads) {
    b.solid.floor(road, 0.032, shade(p.road, 1));
    const alongX = road.maxX - road.minX > road.maxZ - road.minZ;
    const c = alongX ? (road.minZ + road.maxZ) / 2 : (road.minX + road.maxX) / 2;
    const [lo, hi] = alongX ? [road.minX, road.maxX] : [road.minZ, road.maxZ];
    for (let t = lo + 1; t + 2 < hi; t += 4)
      b.solid.floor(
        alongX
          ? { minX: t, maxX: t + 2, minZ: c - 0.08, maxZ: c + 0.08 }
          : { minX: c - 0.08, maxX: c + 0.08, minZ: t, maxZ: t + 2 },
        0.034,
        shade(p.neon, 0.5),
      );
  }
  if (l.islandCore) {
    // cœur de l'îlot du U : haie basse, sans découpe (mobilier)
    const r = l.islandCore;
    const cx = (r.minX + r.maxX) / 2;
    const cz = (r.minZ + r.maxZ) / 2;
    b.solid.block(
      cx,
      0,
      cz,
      r.maxX - r.minX,
      1.2,
      r.maxZ - r.minZ,
      shade(data.config.palette.vegetation, 0.7),
    );
  }
  b.solid.cuttable = true;
}

/** Face de la façade sur rue et signe de `u` (décalages de la maison le long de +Z monde). */
function frontFace(h: House): { f: Face; uSign: number } {
  return h.side < 0
    ? { f: faceOf(h.rect, 'east'), uSign: 1 }
    : { f: faceOf(h.rect, 'west'), uSign: -1 };
}

function house(b: Batches, h: House, q: QuartierParams, sky: string) {
  const r = h.rect;
  const cx = (r.minX + r.maxX) / 2;
  const cz = (r.minZ + r.maxZ) / 2;
  const w = r.maxX - r.minX;
  const d = r.maxZ - r.minZ;
  const facade = shade(h.facade, 1);
  const roof = shade(h.roofColor, 1);
  b.solid.block(cx, 0, cz, w, h.height, d, facade);
  b.solid.block(cx, 0, cz, w + 0.08, 0.35, d + 0.08, shade(h.facade, 0.7)); // soubassement
  roofOf(b.solid, h, cx, cz, w, d, roof);

  const { f, uSign } = frontFace(h);
  const u = (offset: number) => offset * uSign;
  const doorU = h.door.z - cz;
  // porte (panneau + imposte lumineuse), garage, fenêtres allumées ou éteintes
  b.solid.faceBox(f, u(doorU), DOOR_H / 2 + 0.05, DOOR_W + 0.3, DOOR_H + 0.1, 0.1, shade(sky, 0.4));
  b.solid.facePlane(f, u(doorU), DOOR_H / 2, DOOR_W, DOOR_H, shade(h.doorColor, 1), 0.12);
  b.glow.facePlane(f, u(doorU), DOOR_H + 0.25, DOOR_W, 0.18, shade(q.palette.neon, 0.9), 0.13);
  if (h.garageU !== null) {
    b.solid.facePlane(f, u(h.garageU), GARAGE_H / 2, GARAGE_W, GARAGE_H, shade(h.roofColor, 0.8));
    for (let y = 0.4; y < GARAGE_H; y += 0.45)
      b.solid.facePlane(f, u(h.garageU), y, GARAGE_W, 0.05, shade(h.roofColor, 0.5), 0.04);
  }
  for (const win of h.windows) {
    const y = win.floor * FLOOR_H + 1.6;
    if (win.lit) b.glow.facePlane(f, u(win.u), y, WIN_W, WIN_H, shade(q.palette.windows, 1));
    else b.solid.facePlane(f, u(win.u), y, WIN_W, WIN_H, shade(sky, 0.55));
  }
  // liseré néon sous le toit
  b.glow.facePlane(f, 0, h.height - 0.25, (d - 1) * 0.7, 0.08, shade(q.palette.neon, 0.8), 0.04);
  if (h.porch)
    furniture(b, () => {
      b.solid.faceBox(f, u(doorU), 2.5, 2.4, 0.12, 1.3, roof);
      for (const k of [-1, 1])
        b.solid.faceBox(f, u(doorU) + k * 1.05, 1.25, 0.12, 2.5, 0.12, roof, 1.2);
    });
}

/** Toit plat (dalle), à deux pans (faîtage le long de la rue) ou en dents de scie. */
function roofOf(
  solid: Batch,
  h: House,
  cx: number,
  cz: number,
  w: number,
  d: number,
  color: Color,
) {
  const top = h.height;
  switch (h.roof) {
    case 'flat':
      solid.block(cx, top, cz, w + 0.3, 0.25, d + 0.3, color);
      solid.block(cx, top + 0.25, cz, w - 0.6, 0.35, d - 0.6, shade(h.facade, 0.85));
      return;
    case 'gable': {
      const half = w / 2;
      const slope = Math.hypot(half, half * ROOF_PITCH) + 0.3;
      const a = Math.atan(ROOF_PITCH);
      for (const k of [-1, 1])
        solid.box(
          cx + (k * half) / 2,
          top + (half * ROOF_PITCH) / 2,
          cz,
          slope,
          0.2,
          d + 0.4,
          color,
          0,
          0,
          -k * a,
        );
      // pignons : murs pleins sous les pans
      solid.block(cx, top, cz, w * 0.5, half * ROOF_PITCH * 0.6, d, shade(h.facade, 0.95));
      return;
    }
    case 'sawtooth': {
      const teeth = 3;
      const seg = d / teeth;
      const rise = seg * ROOF_PITCH;
      const a = Math.atan(ROOF_PITCH);
      for (let i = 0; i < teeth; i++) {
        const z0 = cz - d / 2 + seg * (i + 0.5);
        solid.box(cx, top + rise / 2, z0, w + 0.2, 0.18, Math.hypot(seg, rise), color, a);
        // pan incliné vers +Z : verrière verticale côté haut (-Z)
        solid.block(cx, top, z0 - seg / 2 + 0.08, w, rise, 0.16, shade(h.facade, 0.9));
      }
      return;
    }
  }
}

function decor(b: Batches, l: QuartierLayout, q: QuartierParams, data: GameData) {
  const { palette } = data.config;
  const p = q.palette;
  for (const r of l.fences) {
    const cx = (r.minX + r.maxX) / 2;
    const cz = (r.minZ + r.maxZ) / 2;
    // clôtures du jardin caché : plus hautes, planches plus sombres
    const garden = l.gardens.find((g) => g.fences.includes(r));
    const high = garden !== undefined;
    const h = garden ? garden.fenceHeight : FENCE_H;
    const color = shade(p.roofs[0]!, high ? 0.6 : 0.9);
    b.solid.block(cx, 0, cz, r.maxX - r.minX, h, r.maxZ - r.minZ, color);
  }
  for (const r of l.gardenBackfill) b.solid.floor(r, 0.03, shade(palette.ground, 0.4));
  // lueur des jardins : couleur de la trappe (lieu caché), la même pour les leurres
  for (const g of l.gardens) hiddenGarden(b, g, gardenGlowColor(q, data), q, data);
  // arche d'entrée : deux piliers, poutre, enseigne néon (texte en étiquette DOM)
  const { arch } = l;
  const archColor = shade(p.roofs[0]!, 0.8);
  for (const pillar of [arch.left, arch.right])
    b.solid.block(pillar.x, 0, pillar.z, 0.7, arch.height, 0.7, archColor);
  const span = arch.right.x - arch.left.x;
  const mid = (arch.left.x + arch.right.x) / 2;
  b.solid.block(mid, arch.height - 0.9, arch.left.z, span + 0.7, 0.9, 0.5, archColor);
  b.glow.block(mid, arch.height - 0.75, arch.left.z, span * 0.8, 0.5, 0.56, shade(p.neon, 1.1));
  // portail devant le bâtiment du bout
  if (l.gate) {
    const g = l.gate;
    for (const pillar of [g.left, g.right]) {
      b.solid.block(pillar.x, 0, pillar.z, 0.6, 3.2, 0.6, archColor);
      b.glow.block(pillar.x, 3.2, pillar.z, 0.4, 0.4, 0.4, shade(p.neon, 1));
    }
    for (let x = g.left.x + 0.6; x < g.left.x + 2; x += 0.35)
      for (const side of [0, 1]) {
        const bx = side === 0 ? x : g.right.x - (x - g.left.x);
        b.solid.block(bx, 0, g.left.z, 0.06, 2.4, 0.06, shade(p.lamp, 0.6));
      }
  }
  // gardes statiques (blocs de couleur ; étiquette « Garde » en DOM)
  for (const guard of l.guards) {
    b.solid.block(guard.x, 0, guard.z, 0.6, 1.25, 0.4, shade(palette.sky, 1.3));
    b.solid.block(guard.x, 1.25, guard.z, 0.36, 0.36, 0.36, shade(palette.wall, 1.4));
    b.glow.block(guard.x, 1.45, guard.z, 0.38, 0.06, 0.38, shade(p.neon, 0.7)); // lunettes
  }
  for (const garland of l.garlands) bulbs(b.glow, garland.a, garland.b, garland.y, q);
}

/** Guirlande : ampoules alternées néon / fenêtre, légère courbe vers le bas. */
function bulbs(glow: Batch, a: Vec2, bEnd: Vec2, y: number, q: QuartierParams) {
  const len = Math.hypot(bEnd.x - a.x, bEnd.z - a.z);
  const n = Math.max(2, Math.floor(len / BULB_STEP));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const sag = 4 * t * (1 - t) * 0.6;
    const color = shade(i % 2 === 0 ? q.palette.neon : q.palette.windows, 1);
    glow.box(a.x + (bEnd.x - a.x) * t, y - sag, a.z + (bEnd.z - a.z) * t, 0.14, 0.14, 0.14, color);
  }
}

/** Une source émissive d'un jardin caché, relative à son emplacement central. */
export interface GardenLight {
  dx: number;
  dz: number;
  y: number;
  w: number;
  h: number;
  d: number;
  color: string;
  k: number;
}

/**
 * Lueur au ras du sol et ampoule nue d'un jardin caché : mêmes paramètres pour le vrai jardin
 * et les leurres (rien ne les distingue depuis la rue), seule la couleur vient des données.
 */
export function gardenLights(glowColor: string): GardenLight[] {
  return [
    { dx: 0, dz: -0.64, y: 0.005, w: 1.2, h: 0.03, d: 0.08, color: glowColor, k: 0.7 },
    { dx: -0.64, dz: 0, y: 0.005, w: 0.08, h: 0.03, d: 1.2, color: glowColor, k: 0.5 },
    { dx: 0.6, dz: 0, y: 2.2, w: 0.16, h: 0.2, d: 0.16, color: glowColor, k: 1.2 },
  ];
}

/** Couleur de la lueur des jardins d'un quartier : celle de la trappe, la même pour les leurres. */
export function gardenGlowColor(q: QuartierParams, data: GameData): string {
  const trapLoc = q.cellarLocationId ? data.locations.get(q.cellarLocationId) : undefined;
  return trapLoc?.neonColor ?? q.palette.lamp;
}

/**
 * Jardin caché (le vrai ou un leurre, rendus à l'identique) : passage dans l'ombre, jardin
 * d'herbe sèche, lueur discrète qui filtre du sol, ampoule nue, vieux fauteuil. Au centre :
 * trappe en bois à poignée (vrai jardin) ou coffre cassé (leurre), même lueur, même intensité.
 * Caisses et poubelle des jardins sont instanciées avec le décor (Decor.tsx).
 */
function hiddenGarden(
  b: Batches,
  g: QuartierLayout['gardens'][number],
  glowColor: string,
  q: QuartierParams,
  data: GameData,
) {
  const { palette } = data.config;
  b.solid.floor(g.passage, 0.04, shade(palette.ground, 0.35));
  b.solid.floor(g.garden, 0.04, mix(palette.vegetation, palette.neon, 0.45).multiplyScalar(0.55));
  // touffes d'herbe sèche (déterministes : sur une grille du jardin)
  for (let x = g.garden.minX + 0.7; x < g.garden.maxX - 0.5; x += 1.9)
    for (let z = g.garden.minZ + 0.9; z < g.garden.maxZ - 0.5; z += 2.3) {
      if (Math.hypot(x - g.spot.x, z - g.spot.z) < 1.4) continue;
      b.solid.block(x, 0, z, 0.35, 0.25, 0.35, mix(palette.vegetation, palette.neon, 0.6));
    }
  const t = g.spot;
  if (g.trapdoor) {
    // trappe : plateau, lattes, poignée métallique
    b.solid.block(t.x, 0, t.z, 1.2, 0.08, 1.2, shade(palette.neon, 0.4));
    for (const dz of [-0.3, 0, 0.3])
      b.solid.block(t.x, 0.08, t.z + dz, 1.15, 0.02, 0.08, shade(palette.neon, 0.3));
    b.solid.block(t.x + 0.4, 0.1, t.z, 0.1, 0.08, 0.35, shade(palette.sky, 2.2));
  } else {
    // coffre cassé : caisse éventrée, couvercle de travers, planches au sol
    b.solid.block(t.x, 0, t.z, 0.9, 0.55, 0.9, shade(palette.neon, 0.38));
    b.solid.box(t.x + 0.15, 0.7, t.z - 0.1, 0.95, 0.06, 0.6, shade(palette.neon, 0.3), 0, 0.4, 0.5);
    b.solid.block(t.x - 0.7, 0, t.z + 0.3, 0.9, 0.04, 0.12, shade(palette.neon, 0.3));
  }
  for (const l of gardenLights(glowColor))
    b.glow.block(t.x + l.dx, l.y, t.z + l.dz, l.w, l.h, l.d, shade(l.color, l.k));
  // ampoule nue sur un poteau, fil compris
  const pole = { x: t.x + 1.4, z: t.z };
  b.solid.block(pole.x, 0, pole.z, 0.1, 2.6, 0.1, shade(palette.sky, 1.4));
  b.solid.block((pole.x + t.x + 0.6) / 2, 2.55, t.z, 0.8, 0.03, 0.03, shade(palette.sky, 0.8));
  // vieux fauteuil défoncé
  const a = g.armchair;
  const seat = shade(q.palette.doors[0]!, 0.55);
  b.solid.block(a.x, 0, a.z, 0.9, 0.45, 0.8, seat);
  b.solid.block(a.x, 0.45, a.z + 0.32, 0.9, 0.55, 0.16, seat);
  for (const dx of [-0.42, 0.42]) b.solid.block(a.x + dx, 0.45, a.z, 0.12, 0.25, 0.8, seat);
}
