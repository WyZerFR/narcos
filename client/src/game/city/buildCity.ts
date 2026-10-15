import type { BufferGeometry, Color } from 'three';
import {
  expandRect,
  footprint,
  rectFromCenter,
  rectsOverlap,
  type Block,
  type DoorSide,
  type GameData,
  type GameLocation,
  type Rect,
} from '@narco/shared';
import { Batch, faceOf, mix, seeded, shade, SIDES, type Face } from './batch';

/**
 * Génère toute la ville en deux géométries fusionnées :
 * - `solid` : murs, toits, sol (MeshLambert, éclairé) ;
 * - `glow`  : fenêtres allumées, portes, néons (MeshBasic émissif, nourrit le bloom).
 * Les dimensions de lieux, couleurs et densités viennent des JSON ; les constantes ci-dessous
 * ne sont que du style de modélisation (taille d'une fenêtre, hauteur d'étage…).
 */

const FLOOR_H = 3;
const WIN_W = 1.1;
const WIN_H = 1.4;
const WIN_STEP = 2.6;
const PARAPET_H = 0.5;

interface Ctx {
  solid: Batch;
  glow: Batch;
  data: GameData;
}

export interface CityGeometry {
  solid: BufferGeometry;
  glow: BufferGeometry;
}

export function buildCity(data: GameData): CityGeometry {
  const ctx: Ctx = { solid: new Batch(), glow: new Batch(), data };
  buildGround(ctx);
  for (const loc of data.locations.values()) buildLocation(ctx, loc);
  for (const block of data.blocks) buildFiller(ctx, block);
  return { solid: ctx.solid.build(), glow: ctx.glow.build() };
}

// ---------------------------------------------------------------- éléments communs

/**
 * Mobilier posé devant ou entre les façades (étals, colonnes, guirlandes) : fusionné avec la
 * ville mais jamais percé par la découpe, réservée aux murs (`aCut = 0`, aucun draw call).
 */
function furniture(ctx: Ctx, build: () => void): void {
  ctx.solid.cuttable = false;
  ctx.glow.cuttable = false;
  build();
  ctx.solid.cuttable = true;
  ctx.glow.cuttable = true;
}

function litColor(ctx: Ctx, rng: () => number): Color {
  return shade(ctx.data.config.palette.neon, 0.65 + rng() * 0.45);
}

/** Grille de fenêtres sur une façade ; `skipU` laisse la place à la porte au rez-de-chaussée. */
function windows(
  ctx: Ctx,
  f: Face,
  fromY: number,
  toY: number,
  rng: () => number,
  dark: Color,
  skipU = 0,
) {
  const cols = Math.floor((f.len - 1.2) / WIN_STEP);
  if (cols < 1) return;
  const start = (-(cols - 1) * WIN_STEP) / 2;
  const ratio = ctx.data.config.decor.windowLitRatio;
  for (let y = fromY; y + WIN_H / 2 < toY; y += FLOOR_H) {
    for (let i = 0; i < cols; i++) {
      const u = start + i * WIN_STEP;
      if (skipU > 0 && Math.abs(u) < skipU && y < FLOOR_H) continue;
      if (rng() < ratio) ctx.glow.facePlane(f, u, y, WIN_W, WIN_H, litColor(ctx, rng));
      else ctx.solid.facePlane(f, u, y, WIN_W, WIN_H, dark);
    }
  }
}

function parapet(ctx: Ctx, r: Rect, top: number, color: Color) {
  const w = r.maxX - r.minX;
  const d = r.maxZ - r.minZ;
  const cx = (r.minX + r.maxX) / 2;
  const cz = (r.minZ + r.maxZ) / 2;
  const t = 0.3;
  ctx.solid.block(cx, top, r.minZ + t / 2, w, PARAPET_H, t, color);
  ctx.solid.block(cx, top, r.maxZ - t / 2, w, PARAPET_H, t, color);
  ctx.solid.block(r.minX + t / 2, top, cz, t, PARAPET_H, d, color);
  ctx.solid.block(r.maxX - t / 2, top, cz, t, PARAPET_H, d, color);
}

function rooftopClutter(ctx: Ctx, r: Rect, top: number, rng: () => number, color: Color) {
  const n = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const w = 1 + rng() * 1.5;
    const d = 1 + rng() * 1.5;
    const x = r.minX + 1 + w / 2 + rng() * Math.max(0, r.maxX - r.minX - 2 - w);
    const z = r.minZ + 1 + d / 2 + rng() * Math.max(0, r.maxZ - r.minZ - 2 - d);
    ctx.solid.block(x, top, z, w, 0.6 + rng() * 0.8, d, color);
  }
}

function door(ctx: Ctx, f: Face, u: number, w: number, h: number, glowColor: Color) {
  ctx.solid.faceBox(
    f,
    u,
    h / 2 + 0.1,
    w + 0.4,
    h + 0.2,
    0.12,
    shade(ctx.data.config.palette.sky, 0.3),
  );
  ctx.glow.facePlane(f, u, h / 2, w, h, glowColor, 0.14);
}

/** Façade la plus proche d'une route (pour orienter la porte des immeubles). */
function sideTowardRoad(ctx: Ctx, r: Rect): DoorSide {
  const cx = (r.minX + r.maxX) / 2;
  const cz = (r.minZ + r.maxZ) / 2;
  let best: DoorSide = 'south';
  let bestDist = Infinity;
  for (const side of SIDES) {
    const f = faceOf(r, side);
    for (const road of ctx.data.config.map.roads) {
      const rr = rectFromCenter(road, road);
      const px = f.cx + f.nx * 3;
      const pz = f.cz + f.nz * 3;
      const dx = Math.max(rr.minX - px, 0, px - rr.maxX);
      const dz = Math.max(rr.minZ - pz, 0, pz - rr.maxZ);
      const dist = Math.hypot(dx, dz) + Math.hypot(f.cx - cx, f.cz - cz) * 0.01;
      if (dist < bestDist) {
        bestDist = dist;
        best = side;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------- sol

/** Bandes de trottoir de part et d'autre d'une route, coupées aux croisements. */
function sidewalkStrips(road: Rect, others: Rect[], sw: number): Rect[] {
  const alongX = road.maxX - road.minX >= road.maxZ - road.minZ;
  const strips: Rect[] = alongX
    ? [
        { ...road, minZ: road.minZ - sw, maxZ: road.minZ },
        { ...road, minZ: road.maxZ, maxZ: road.maxZ + sw },
      ]
    : [
        { ...road, minX: road.minX - sw, maxX: road.minX },
        { ...road, minX: road.maxX, maxX: road.maxX + sw },
      ];
  const out: Rect[] = [];
  for (const strip of strips) {
    let pieces = [strip];
    for (const o of others) {
      if (!rectsOverlap(o, strip)) continue;
      pieces = pieces.flatMap((p) =>
        alongX
          ? [
              { ...p, maxX: Math.min(p.maxX, o.minX) },
              { ...p, minX: Math.max(p.minX, o.maxX) },
            ]
          : [
              { ...p, maxZ: Math.min(p.maxZ, o.minZ) },
              { ...p, minZ: Math.max(p.minZ, o.maxZ) },
            ],
      );
      pieces = pieces.filter((p) => p.maxX - p.minX > 0.01 && p.maxZ - p.minZ > 0.01);
    }
    out.push(...pieces);
  }
  return out;
}

function buildGround(ctx: Ctx) {
  const { palette, map, world } = ctx.data.config;
  const { solid } = ctx;
  // Le sol (trottoirs compris) n'est jamais percé par la découpe.
  solid.cuttable = false;
  solid.floor(expandRect(world.bounds, 30), -0.02, shade(palette.ground, 0.45));
  solid.floor(world.bounds, 0, shade(palette.ground, 0.7));

  const roads = map.roads.map((r) => rectFromCenter(r, r));
  const curb = shade(palette.ground, 0.8);
  roads.forEach((road, i) => {
    const others = roads.filter((_, j) => j !== i);
    solid.floor(road, 0.02, shade(palette.street, 1.6));
    for (const s of sidewalkStrips(road, others, map.sidewalkWidth)) {
      const cx = (s.minX + s.maxX) / 2;
      const cz = (s.minZ + s.maxZ) / 2;
      solid.block(cx, 0, cz, s.maxX - s.minX, 0.12, s.maxZ - s.minZ, shade(palette.ground, 1.3));
      // bordure de trottoir, un ton plus sombre
      solid.block(cx, 0.12, cz, s.maxX - s.minX, 0.02, s.maxZ - s.minZ, curb);
    }
    // marquage central en pointillés, interrompu aux croisements
    const alongX = road.maxX - road.minX >= road.maxZ - road.minZ;
    const dash = shade(palette.neon, 0.55);
    const len = alongX ? road.maxX - road.minX : road.maxZ - road.minZ;
    for (let t = 1; t + 2 < len; t += 4) {
      const r: Rect = alongX
        ? { minX: road.minX + t, maxX: road.minX + t + 2, minZ: -0.08, maxZ: 0.08 }
        : { minX: -0.08, maxX: 0.08, minZ: road.minZ + t, maxZ: road.minZ + t + 2 };
      const centered: Rect = alongX
        ? {
            ...r,
            minZ: (road.minZ + road.maxZ) / 2 - 0.08,
            maxZ: (road.minZ + road.maxZ) / 2 + 0.08,
          }
        : {
            ...r,
            minX: (road.minX + road.maxX) / 2 - 0.08,
            maxX: (road.minX + road.maxX) / 2 + 0.08,
          };
      if (others.some((o) => rectsOverlap(expandRect(o, 1), centered))) continue;
      solid.floor(centered, 0.03, dash);
    }
  });

  const stripe = shade(palette.ground, 3.4);
  for (const cw of map.crosswalks) {
    for (let t = -cw.length / 2 + 0.5; t < cw.length / 2; t += 1) {
      const r =
        cw.axis === 'z'
          ? rectFromCenter({ x: cw.x, z: cw.z + t }, { w: cw.width, d: 0.5 })
          : rectFromCenter({ x: cw.x + t, z: cw.z }, { w: 0.5, d: cw.width });
      solid.floor(r, 0.035, stripe);
    }
  }
  solid.cuttable = true;
}

// ---------------------------------------------------------------- lieux

function buildLocation(ctx: Ctx, loc: GameLocation) {
  const rng = seeded(loc.id);
  switch (loc.silhouette) {
    case 'warehouse':
      return warehouse(ctx, loc, rng);
    case 'corner_shop':
      return cornerShop(ctx, loc, rng);
    case 'villa_tower':
      return villaTower(ctx, loc, rng);
    case 'hardware':
      return hardware(ctx, loc, rng);
    case 'kiosk':
      return kiosk(ctx, loc, rng);
    case 'alley':
      return alley(ctx, loc, rng);
    case 'bank':
      return bank(ctx, loc, rng);
  }
}

/**
 * Banque : bloc de pierre clair, colonnade et fronton sur la façade, marches, enseigne néon
 * horizontale et liseré au fronton. Sage et respectable : tout ce que la clientèle n'est pas.
 */
function bank(ctx: Ctx, loc: GameLocation, rng: () => number) {
  const { palette } = ctx.data.config;
  const r = footprint(loc);
  const h = loc.height;
  const f = faceOf(r, loc.door ?? 'south');
  const stone = shade(loc.color, 1.25);
  ctx.solid.block(
    loc.position.x,
    0,
    loc.position.z,
    loc.size.w,
    h,
    loc.size.d,
    shade(loc.color, 1),
  );
  parapet(ctx, r, h, shade(loc.color, 0.8));
  // marches
  ctx.solid.faceBox(f, 0, 0.1, f.len * 0.8, 0.2, 0.6, shade(palette.ground, 1.4), 0.3);
  // colonnade
  const cols = 4;
  const colH = h - 1.6;
  for (let i = 0; i < cols; i++) {
    const u = (i / (cols - 1) - 0.5) * f.len * 0.7;
    ctx.solid.faceBox(f, u, 0.2 + colH / 2, 0.5, colH, 0.5, stone, 0.25);
  }
  // entablement + fronton en gradins
  ctx.solid.faceBox(f, 0, colH + 0.5, f.len * 0.85, 0.6, 0.7, stone, 0.3);
  ctx.solid.faceBox(f, 0, colH + 1.05, f.len * 0.6, 0.5, 0.6, stone, 0.3);
  ctx.solid.faceBox(f, 0, colH + 1.5, f.len * 0.3, 0.4, 0.5, stone, 0.25);
  // enseigne néon au-dessus de la porte, liseré sous l'entablement
  ctx.glow.faceBox(f, 0, colH + 0.5, f.len * 0.5, 0.35, 0.08, shade(loc.neonColor, 1), 0.7);
  ctx.glow.faceBox(f, 0, colH + 0.12, f.len * 0.8, 0.06, 0.06, shade(loc.neonColor, 0.6), 0.65);
  door(ctx, f, 0, 1.6, 2.6, shade(palette.neon, 0.8));
  for (const side of SIDES)
    if (side !== loc.door) windows(ctx, faceOf(r, side), 1.8, h, rng, shade(loc.color, 0.45));
}

/** Le local : entrepôt bas et large, rideau métallique, lucarnes roses (on devine le labo). */
function warehouse(ctx: Ctx, loc: GameLocation, rng: () => number) {
  const { palette } = ctx.data.config;
  const r = footprint(loc);
  const h = loc.height;
  const wall = shade(loc.color, 1);
  const f = faceOf(r, loc.door ?? 'south');
  ctx.solid.block(loc.position.x, 0, loc.position.z, loc.size.w, h, loc.size.d, wall);
  // bande haute et bardage vertical
  for (const side of SIDES) {
    const face = faceOf(r, side);
    ctx.solid.faceBox(face, 0, h - 0.4, face.len, 0.8, 0.1, shade(loc.color, 0.7));
    for (let u = -face.len / 2 + 1; u < face.len / 2; u += 1.5) {
      ctx.solid.faceBox(face, u, (h - 0.8) / 2, 0.12, h - 0.8, 0.06, shade(loc.color, 0.85));
    }
  }
  // rideau métallique + lames
  const shutterU = -f.len * 0.15;
  ctx.solid.faceBox(f, shutterU, 1.9, 6, 3.8, 0.16, shade(palette.wall, 1.3));
  for (let y = 0.4; y < 3.8; y += 0.45)
    ctx.solid.faceBox(f, shutterU, y, 6, 0.06, 0.22, shade(palette.wall, 0.8));
  door(ctx, f, f.len * 0.3, 1, 2.2, shade(loc.neonColor, 0.9));
  // enseigne néon double
  ctx.glow.faceBox(f, 0, h - 1.4, f.len * 0.55, 0.3, 0.12, shade(loc.neonColor, 1), 0.2);
  ctx.glow.faceBox(f, 0, h - 1.9, f.len * 0.35, 0.12, 0.1, shade(palette.neon, 1), 0.2);
  // lucarnes de toit qui laissent fuir une lueur rose
  for (let i = -1; i <= 1; i++) {
    ctx.glow.block(
      loc.position.x + i * loc.size.w * 0.28,
      h,
      loc.position.z,
      1.6,
      0.25,
      2.6,
      shade(loc.neonColor, 0.55),
    );
  }
  // tags sur la façade opposée
  const back = faceOf(r, opposite(loc.door ?? 'south'));
  for (let i = 0; i < 4; i++) {
    const c = i % 2 ? shade(loc.neonColor, 0.45) : shade(palette.vegetation, 0.9);
    ctx.solid.facePlane(
      back,
      (rng() - 0.5) * back.len * 0.8,
      0.8 + rng() * 1.6,
      1 + rng() * 2,
      0.5 + rng(),
      c,
    );
  }
}

/** Épicerie : deux étages, vitrine éclairée, store rayé, étals de fruits. */
function cornerShop(ctx: Ctx, loc: GameLocation, rng: () => number) {
  const { palette } = ctx.data.config;
  const r = footprint(loc);
  const h = loc.height;
  const f = faceOf(r, loc.door ?? 'south');
  ctx.solid.block(
    loc.position.x,
    0,
    loc.position.z,
    loc.size.w,
    h,
    loc.size.d,
    shade(loc.color, 1),
  );
  ctx.solid.faceBox(f, 0, 3.6, f.len, 0.25, 0.3, shade(loc.color, 0.6)); // corniche entre étages
  parapet(ctx, r, h, shade(loc.color, 0.7));
  // vitrine + porte
  ctx.glow.facePlane(f, f.len * 0.12, 1.5, f.len * 0.55, 2, shade(palette.neon, 1.15));
  door(ctx, f, -f.len * 0.32, 1.3, 2.3, shade(loc.neonColor, 0.8));
  // store rayé incliné
  const stripes = 9;
  const sw = (f.len * 0.9) / stripes;
  for (let i = 0; i < stripes; i++) {
    const u = -f.len * 0.45 + sw * (i + 0.5);
    const c = i % 2 ? shade(loc.neonColor, 0.55) : shade(palette.ground, 2.2);
    ctx.solid.faceBox(f, u, 3.05, sw, 0.08, 1.8, c, 0.85, 0.35);
  }
  // enseigne
  ctx.glow.faceBox(f, 0, 4.3, f.len * 0.6, 0.55, 0.14, shade(loc.neonColor, 1), 0.12);
  // étals de fruits de chaque côté de la porte
  furniture(ctx, () => {
    for (const u of [f.len * 0.38, -f.len * 0.1]) {
      ctx.solid.faceBox(f, u, 0.45, 1.3, 0.9, 0.8, shade(palette.wall, 0.8), 1.3);
      ctx.solid.faceBox(
        f,
        u,
        0.98,
        1.2,
        0.16,
        0.7,
        rng() > 0.5 ? shade(palette.vegetation, 1.4) : shade(palette.neon, 0.9),
        1.3,
      );
    }
  });
  // étage
  windows(ctx, f, 5.3, h, rng, shade(loc.color, 0.4));
  for (const side of SIDES)
    if (side !== loc.door) windows(ctx, faceOf(r, side), 1.8, h, rng, shade(loc.color, 0.4));
}

/** Repaire d'El Jefe : podium, tour, couronne dorée, colonnes. La silhouette la plus haute. */
function villaTower(ctx: Ctx, loc: GameLocation, rng: () => number) {
  const { palette } = ctx.data.config;
  const r = footprint(loc);
  const h = loc.height;
  const podiumH = 4;
  const gold = shade(loc.neonColor, 1);
  const f = faceOf(r, loc.door ?? 'north');
  ctx.solid.block(
    loc.position.x,
    0,
    loc.position.z,
    loc.size.w,
    podiumH,
    loc.size.d,
    shade(loc.color, 1.3),
  );
  parapet(ctx, r, podiumH, shade(loc.neonColor, 0.45));
  const inset = 2.5;
  const tower = expandRect(r, -inset);
  const tw = tower.maxX - tower.minX;
  const td = tower.maxZ - tower.minZ;
  ctx.solid.block(
    loc.position.x,
    podiumH,
    loc.position.z,
    tw,
    h - podiumH,
    td,
    shade(loc.color, 1),
  );
  for (const side of SIDES) {
    const tf = faceOf(tower, side);
    windows(ctx, tf, podiumH + 1.8, h - 1, rng, shade(loc.color, 0.5));
    // liserés dorés verticaux aux angles
    ctx.glow.faceBox(
      tf,
      tf.len / 2 - 0.1,
      (h + podiumH) / 2,
      0.15,
      h - podiumH,
      0.15,
      shade(loc.neonColor, 0.7),
    );
  }
  // couronne
  ctx.glow.block(loc.position.x, h, loc.position.z, tw + 0.3, 0.3, td + 0.3, gold);
  ctx.solid.block(
    loc.position.x,
    h + 0.3,
    loc.position.z,
    tw * 0.55,
    1,
    td * 0.55,
    shade(loc.neonColor, 0.5),
  );
  ctx.solid.block(
    loc.position.x,
    h + 1.3,
    loc.position.z,
    tw * 0.28,
    1,
    td * 0.28,
    shade(loc.neonColor, 0.6),
  );
  ctx.glow.block(loc.position.x, h + 2.3, loc.position.z, 0.3, 2.5, 0.3, gold);
  // portique à colonnes
  furniture(ctx, () => {
    for (const u of [-3.3, -1.7, 1.7, 3.3])
      ctx.solid.faceBox(f, u, 1.9, 0.5, 3.8, 0.5, shade(palette.ground, 2.3), 1.6);
    ctx.solid.faceBox(f, 0, 3.95, 8, 0.3, 2.3, shade(palette.ground, 2), 1.15);
    ctx.glow.faceBox(f, 0, 3.75, 7, 0.12, 0.1, gold, 2.3);
  });
  door(ctx, f, 0, 2.4, 2.8, shade(loc.neonColor, 0.8));
  ctx.glow.faceBox(f, 0, podiumH - 0.9, f.len * 0.5, 0.35, 0.12, gold, 0.1);
}

/** Bricoshop : toit en dents de scie, grand panneau sur le toit, porte de garage ouverte. */
function hardware(ctx: Ctx, loc: GameLocation, rng: () => number) {
  const { palette } = ctx.data.config;
  const r = footprint(loc);
  const bodyH = loc.height - 2;
  const f = faceOf(r, loc.door ?? 'north');
  ctx.solid.block(
    loc.position.x,
    0,
    loc.position.z,
    loc.size.w,
    bodyH,
    loc.size.d,
    shade(loc.color, 1),
  );
  // dents de scie le long de X
  const teeth = 4;
  const tw = loc.size.w / teeth;
  const toothH = 1.6;
  const angle = Math.atan2(toothH, tw);
  for (let i = 0; i < teeth; i++) {
    const x0 = r.minX + i * tw;
    ctx.solid.box(
      x0 + tw / 2,
      bodyH + toothH / 2,
      loc.position.z,
      Math.hypot(tw, toothH),
      0.25,
      loc.size.d,
      shade(loc.color, 0.75),
      0,
      0,
      angle,
    );
    ctx.glow.block(
      x0 + tw - 0.06,
      bodyH,
      loc.position.z,
      0.08,
      toothH,
      loc.size.d - 0.4,
      shade(palette.neon, 0.5),
    );
  }
  // grand panneau sur poteaux, en retrait de la façade
  const boardY = loc.height + 1.6;
  for (const u of [-f.len * 0.25, f.len * 0.25])
    ctx.solid.faceBox(f, u, loc.height + 0.3, 0.2, 2.6, 0.2, shade(palette.wall, 0.5), -1.5);
  ctx.solid.faceBox(f, 0, boardY, f.len * 0.75, 1.6, 0.25, shade(palette.wall, 0.45), -1.5);
  ctx.glow.faceBox(f, 0, boardY, f.len * 0.62, 0.55, 0.1, shade(loc.neonColor, 1), -1.3);
  ctx.glow.faceBox(f, 0, boardY - 0.62, f.len * 0.7, 0.08, 0.08, shade(palette.neon, 1), -1.3);
  // porte de garage ouverte (intérieur chaud) + bandes de chantier
  ctx.glow.facePlane(f, -f.len * 0.15, 1.7, 5, 3.4, shade(palette.neon, 0.85));
  for (let i = 0; i < 6; i++) {
    const c = i % 2 ? shade(loc.neonColor, 0.9) : shade(palette.street, 0.5);
    ctx.solid.faceBox(f, -f.len * 0.15 - 2.5 + i, 3.55, 1, 0.3, 0.1, c, 0.08);
  }
  door(ctx, f, f.len * 0.33, 1.1, 2.2, shade(loc.neonColor, 0.7));
  for (const side of SIDES)
    if (side !== loc.door) windows(ctx, faceOf(r, side), 2.2, bodyH, rng, shade(loc.color, 0.4));
}

/** Point relais : kiosque bas, auvent, mur de consignes lumineuses. */
function kiosk(ctx: Ctx, loc: GameLocation, rng: () => number) {
  const { palette } = ctx.data.config;
  const r = footprint(loc);
  const h = loc.height;
  const f = faceOf(r, loc.door ?? 'south');
  ctx.solid.block(
    loc.position.x,
    0,
    loc.position.z,
    loc.size.w,
    h,
    loc.size.d,
    shade(loc.color, 1),
  );
  ctx.solid.block(
    loc.position.x,
    h,
    loc.position.z,
    loc.size.w + 1.2,
    0.3,
    loc.size.d + 1.2,
    shade(loc.color, 1.5),
  );
  ctx.glow.faceBox(f, 0, h + 0.15, f.len + 1.2, 0.12, 0.08, shade(loc.neonColor, 1), 0.62);
  ctx.glow.faceBox(f, 0, h + 0.75, f.len * 0.8, 0.6, 0.15, shade(loc.neonColor, 1), -0.5);
  // consignes : grille de casiers, certains allumés
  const cols = 5;
  const rows = 3;
  const cw = (f.len * 0.55) / cols;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const u = -f.len * 0.42 + cw * (i + 0.5);
      const y = 0.6 + j * 0.75;
      if (rng() < 0.5)
        ctx.glow.facePlane(f, u, y, cw * 0.8, 0.6, shade(loc.neonColor, 0.35 + rng() * 0.4));
      else ctx.solid.facePlane(f, u, y, cw * 0.8, 0.6, shade(palette.wall, 1.4));
    }
  }
  door(ctx, f, f.len * 0.3, 1, 2.1, shade(palette.neon, 0.9));
}

/** Ruelle : sol plus sombre, guirlandes lumineuses en travers, flaque qui reflète le néon. */
function alley(ctx: Ctx, loc: GameLocation, rng: () => number) {
  const { palette } = ctx.data.config;
  const r = footprint(loc);
  ctx.solid.floor(r, 0.015, shade(loc.color, 1));
  const alongZ = loc.size.d >= loc.size.w;
  const length = alongZ ? loc.size.d : loc.size.w;
  const width = alongZ ? loc.size.w : loc.size.d;
  const y = loc.height;
  ctx.solid.cuttable = false;
  ctx.glow.cuttable = false;
  for (let t = -length / 2 + 1.2; t < length / 2; t += 2.4) {
    const cx = alongZ ? loc.position.x : loc.position.x + t;
    const cz = alongZ ? loc.position.z + t : loc.position.z;
    ctx.solid.box(
      cx,
      y + 0.1,
      cz,
      alongZ ? width : 0.03,
      0.03,
      alongZ ? 0.03 : width,
      shade(ctx.data.config.palette.sky, 0.3),
    );
    for (let s = -width / 2 + 0.4; s < width / 2; s += 0.6) {
      const c = Math.round((s + t) / 0.6) % 2 ? shade(loc.neonColor, 1) : shade(palette.neon, 1);
      const sag = Math.cos((s / width) * Math.PI) * -0.25;
      ctx.glow.box(alongZ ? cx + s : cx, y + sag, alongZ ? cz : cz + s, 0.14, 0.14, 0.14, c);
    }
  }
  ctx.solid.cuttable = true;
  ctx.glow.cuttable = true;
  // flaque : reflet discret du néon
  const pr = rectFromCenter(
    {
      x: loc.position.x + (rng() - 0.5) * width * 0.4,
      z: loc.position.z + (rng() - 0.5) * length * 0.3,
    },
    alongZ ? { w: width * 0.5, d: 2.2 } : { w: 2.2, d: width * 0.5 },
  );
  ctx.glow.floor(pr, 0.025, shade(loc.neonColor, 0.18));
}

// ---------------------------------------------------------------- immeubles de remplissage

function buildFiller(ctx: Ctx, block: Block) {
  const { palette } = ctx.data.config;
  const rng = seeded(block.id);
  const r = footprint(block);
  const wall = block.color ? shade(block.color, 1) : shade(palette.wall, 0.75 + rng() * 0.5);
  const dark = mix(palette.sky, palette.wall, 0.4).multiplyScalar(0.6);
  ctx.solid.block(
    block.position.x,
    0,
    block.position.z,
    block.size.w,
    block.height,
    block.size.d,
    wall,
  );
  parapet(ctx, r, block.height, wall.clone().multiplyScalar(0.7));
  rooftopClutter(ctx, r, block.height, rng, wall.clone().multiplyScalar(0.85));
  const doorSide = sideTowardRoad(ctx, r);
  for (const side of SIDES) {
    const f = faceOf(r, side);
    windows(ctx, f, 1.8, block.height, rng, dark, side === doorSide ? 1.6 : 0);
    // bandeau de rez-de-chaussée
    ctx.solid.faceBox(f, 0, 3.1, f.len, 0.2, 0.15, wall.clone().multiplyScalar(0.6));
  }
  door(ctx, faceOf(r, doorSide), 0, 1.4, 2.3, shade(palette.neon, 0.7));
}

function opposite(side: DoorSide): DoorSide {
  return ({ north: 'south', south: 'north', east: 'west', west: 'east' } as const)[side];
}
