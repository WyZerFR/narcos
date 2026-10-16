import type { Color } from 'three';
import { footprint, type Block, type DoorSide, type GameData, type Rect } from '@narco/shared';
import { faceOf, shade, SIDES, type Batch, type Face } from './batch';

/**
 * Façades de repère du centre-ville et du quartier commercial (commissariat, concession,
 * armurerie, laverie, barbier, kebab, commerces, parking), couronnes néon des tours et panneaux
 * d'entrée d'area. Tout est fusionné dans les deux géométries de la ville : aucun draw call en
 * plus. Le texte des enseignes est une étiquette DOM (labels.tsx). Les constantes ne sont que
 * du gabarit de modélisation ; tailles, couleurs et enseignes viennent des JSON.
 */

export interface LandmarkCtx {
  readonly solid: Batch;
  readonly glow: Batch;
  data: GameData;
  /** Aiguillage par area (chargement par area) ; absent : tout dans les mêmes batches. */
  router?: { at(p: { x: number; z: number }): void };
}

/** Outils de façade de buildCity (fenêtres, parapet, porte, mobilier non découpé). */
export interface FacadeKit {
  windows: (f: Face, fromY: number, toY: number, dark: Color, skipU?: number) => void;
  parapet: (r: Rect, top: number, color: Color) => void;
  door: (f: Face, u: number, w: number, h: number, glow: Color) => void;
  furniture: (build: () => void) => void;
}

const SHOP_H = 3.2;
const SIGN_H = 1.1;

/** Couleur d'enseigne d'un immeuble (néon de la palette par défaut). */
function neon(ctx: LandmarkCtx, b: Block, k = 1): Color {
  return shade(b.neonColor ?? ctx.data.config.palette.neon, k);
}

function wallOf(ctx: LandmarkCtx, b: Block, k = 1): Color {
  return shade(b.color ?? ctx.data.config.palette.wall, k);
}

/** Vitrine éclairée + enseigne en caisson au-dessus, sur la façade `f`. */
function shopfront(ctx: LandmarkCtx, kit: FacadeKit, b: Block, f: Face, lit: Color) {
  const w = Math.min(f.len - 1.5, f.len * 0.8);
  ctx.glow.facePlane(f, 0, SHOP_H / 2 + 0.2, w, SHOP_H - 0.6, lit);
  // meneaux sombres de la vitrine
  const dark = shade(ctx.data.config.palette.sky, 0.6);
  for (let u = -w / 2; u <= w / 2 + 0.01; u += w / 4)
    ctx.solid.faceBox(f, u, SHOP_H / 2 + 0.2, 0.12, SHOP_H - 0.6, 0.1, dark, 0.06);
  // caisson d'enseigne et liseré
  ctx.solid.faceBox(f, 0, SHOP_H + SIGN_H / 2, w + 0.4, SIGN_H, 0.4, wallOf(ctx, b, 0.55), 0.2);
  ctx.glow.faceBox(f, 0, SHOP_H + SIGN_H / 2, w * 0.7, SIGN_H * 0.5, 0.1, neon(ctx, b), 0.42);
  ctx.glow.faceBox(f, 0, SHOP_H + 0.05, w + 0.4, 0.06, 0.06, neon(ctx, b, 0.7), 0.42);
  kit.door(f, w / 2 - 0.9, 1.1, 2.2, neon(ctx, b, 0.6));
}

/** Corps de bâtiment commun : volume, parapet, fenêtres d'étage sur toutes les faces. */
function body(ctx: LandmarkCtx, kit: FacadeKit, b: Block, front: DoorSide) {
  const r = footprint(b);
  ctx.solid.block(b.position.x, 0, b.position.z, b.size.w, b.height, b.size.d, wallOf(ctx, b));
  kit.parapet(r, b.height, wallOf(ctx, b, 0.75));
  const dark = wallOf(ctx, b, 0.4);
  for (const side of SIDES)
    kit.windows(faceOf(r, side), side === front ? SHOP_H + SIGN_H + 0.8 : 1.8, b.height, dark);
}

/** Auvent rayé incliné au-dessus de la vitrine. */
function awning(ctx: LandmarkCtx, f: Face, len: number, a: Color, c: Color) {
  const n = Math.max(2, Math.round(len / 0.8));
  for (let i = 0; i < n; i++)
    ctx.solid.faceBox(
      f,
      -len / 2 + (i + 0.5) * (len / n),
      SHOP_H + 0.1,
      len / n,
      0.08,
      1.4,
      i % 2 ? a : c,
      0.7,
      0.35,
    );
}

/** Commissariat : façade sobre, perron, rampe lumineuse bleu-rouge sur le toit, drapeau. */
function police(ctx: LandmarkCtx, kit: FacadeKit, b: Block, f: Face) {
  const { palette } = ctx.data.config;
  body(ctx, kit, b, b.door ?? 'north');
  ctx.solid.faceBox(f, 0, 0.1, f.len * 0.4, 0.2, 1.2, shade(palette.ground, 1.4), 0.6);
  ctx.glow.facePlane(f, 0, 1.6, f.len * 0.25, 2.6, shade(palette.neon, 0.8));
  ctx.solid.faceBox(f, 0, SHOP_H + 0.6, f.len * 0.55, 1.2, 0.4, wallOf(ctx, b, 0.5), 0.2);
  ctx.glow.faceBox(f, 0, SHOP_H + 0.6, f.len * 0.45, 0.6, 0.1, neon(ctx, b), 0.42);
  // rampe de gyrophares sur le toit, côté façade
  const red = shade(palette.danger, 1.2);
  const blue = neon(ctx, b, 1.2);
  for (let i = 0; i < 4; i++)
    ctx.glow.faceBox(f, -1.5 + i, b.height + 0.4, 0.8, 0.35, 0.5, i % 2 ? red : blue, -0.8);
  kit.furniture(() => {
    ctx.solid.faceBox(f, f.len * 0.38, 3, 0.12, 6, 0.12, shade(palette.wall, 0.5), 1.4);
    ctx.glow.faceBox(f, f.len * 0.38 + 0.6, 5.4, 1.1, 0.7, 0.04, blue, 1.4);
  });
}

/**
 * Concession vitrée : dalle, piliers et bandeau de toit ajouré (les voitures exposées, en
 * instancing, se voient d'en haut), allège basse et vitrage en meneaux fins.
 */
function dealership(ctx: LandmarkCtx, kit: FacadeKit, b: Block, f: Face) {
  const { palette } = ctx.data.config;
  const r = footprint(b);
  const frame = wallOf(ctx, b, 0.8);
  const h = b.height;
  ctx.solid.floor(r, 0.06, shade(palette.ground, 1.8));
  for (const x of [r.minX + 0.2, r.maxX - 0.2])
    for (const z of [r.minZ + 0.2, r.maxZ - 0.2]) ctx.solid.block(x, 0, z, 0.4, h, 0.4, frame);
  for (const side of SIDES) {
    const s = faceOf(r, side);
    // allège, bandeau haut, meneaux
    ctx.solid.faceBox(s, 0, 0.3, s.len, 0.6, 0.2, frame, -0.1);
    ctx.solid.faceBox(s, 0, h - 0.4, s.len, 0.8, 0.3, frame, -0.15);
    for (let u = -s.len / 2 + 2; u < s.len / 2 - 1; u += 2.5)
      ctx.solid.faceBox(s, u, h / 2, 0.08, h - 0.8, 0.08, frame, -0.1);
    ctx.glow.faceBox(s, 0, h - 0.05, s.len, 0.08, 0.08, neon(ctx, b, 0.8), 0);
  }
  // poutres du toit ajouré
  for (let x = r.minX + 2.5; x < r.maxX - 1; x += 3)
    ctx.solid.block(x, h - 0.3, b.position.z, 0.25, 0.3, b.size.d, frame);
  // totem de l'enseigne devant la façade
  kit.furniture(() => {
    ctx.solid.faceBox(f, f.len / 2 - 1, 2.5, 0.3, 5, 0.3, frame, 1.5);
    ctx.glow.faceBox(f, f.len / 2 - 1, 4.6, 1.6, 1, 0.2, neon(ctx, b), 1.5);
  });
}

/** Armurerie : volume fermé, vitrine grillagée, pistolet géant en néon sur le toit. */
function gunshop(ctx: LandmarkCtx, kit: FacadeKit, b: Block, f: Face) {
  const { palette } = ctx.data.config;
  body(ctx, kit, b, b.door ?? 'south');
  shopfront(ctx, kit, b, f, shade(palette.neon, 0.5));
  for (let u = -f.len * 0.4; u <= f.len * 0.4; u += 0.5)
    ctx.solid.faceBox(f, u, SHOP_H / 2 + 0.2, 0.05, SHOP_H - 0.6, 0.05, wallOf(ctx, b, 0.5), 0.12);
  // pistolet : canon, carcasse, poignée, au-dessus de la façade
  const red = neon(ctx, b);
  ctx.glow.faceBox(f, 0, b.height + 1.6, 3.2, 0.5, 0.25, red, -0.5);
  ctx.glow.faceBox(f, -0.8, b.height + 1.2, 1.6, 0.4, 0.25, red, -0.5);
  ctx.glow.faceBox(f, -1.1, b.height + 0.55, 0.5, 1.2, 0.25, red, -0.5, -0.25);
  // enseigne cible : anneau carré, réticule et mouche, sur l'angle de la façade
  const u = f.len / 2 - 1.8;
  const y = SHOP_H + SIGN_H + 1.6;
  const gold = shade(ctx.data.config.palette.neon, 1);
  for (const [du, dy, w, h] of [
    [0, 0.9, 2, 0.14],
    [0, -0.9, 2, 0.14],
    [0.93, 0, 0.14, 1.9],
    [-0.93, 0, 0.14, 1.9],
    [0, 0, 1.2, 0.08],
    [0, 0, 0.08, 1.2],
  ] as const)
    ctx.glow.faceBox(f, u + du, y + dy, w, h, 0.08, red, 0.08);
  ctx.glow.faceBox(f, u, y, 0.36, 0.36, 0.1, gold, 0.1);
}

/**
 * Parc de conteneurs du cartel : dalle, conteneurs empilés en quinconce (couleurs dérivées du
 * mur), liseré néon menaçant. Volume solide = l'emprise du bloc (collision inchangée).
 */
function containers(ctx: LandmarkCtx, kit: FacadeKit, b: Block, f: Face) {
  const r = footprint(b);
  ctx.solid.floor(r, 0.05, shade(ctx.data.config.palette.ground, 1.2));
  const len = 6;
  const wid = 2.4;
  const hgt = b.height / 2;
  const tints = [1, 0.7, 1.3, 0.85];
  let k = 0;
  for (let x = r.minX + len / 2; x + len / 2 <= r.maxX + 1e-6; x += len)
    for (let z = r.minZ + wid / 2 + 0.2; z + wid / 2 <= r.maxZ + 1e-6; z += wid + 0.3)
      for (let level = 0; level < 2; level++) {
        if (level === 1 && (k + level) % 3 === 0) continue;
        const c = wallOf(ctx, b, tints[(k + level) % tints.length]!);
        ctx.solid.block(x, level * hgt, z, len - 0.2, hgt - 0.05, wid, c);
        // nervures des portes au bout du conteneur
        ctx.solid.block(
          x + len / 2 - 0.12,
          level * hgt + 0.2,
          z,
          0.1,
          hgt - 0.45,
          wid - 0.4,
          wallOf(ctx, b, 0.5),
        );
        k++;
      }
  kit.furniture(() => ctx.glow.faceBox(f, 0, 0.15, f.len, 0.1, 0.1, neon(ctx, b), 0.2));
}

/**
 * Usine abandonnée : grand volume, toit en sheds, vitres brisées (sombres) à rares carreaux
 * allumés, cheminée, enseigne rouge qui grésille (halo).
 */
function factory(ctx: LandmarkCtx, kit: FacadeKit, b: Block, f: Face) {
  const r = footprint(b);
  const h = b.height;
  ctx.solid.block(b.position.x, 0, b.position.z, b.size.w, h - 1.5, b.size.d, wallOf(ctx, b));
  // sheds : dents de scie le long de X
  const teeth = Math.max(2, Math.round(b.size.w / 4));
  const tw = b.size.w / teeth;
  for (let i = 0; i < teeth; i++) {
    const x = r.minX + tw * (i + 0.5);
    ctx.solid.box(
      x,
      h - 0.75,
      b.position.z,
      tw * 0.98,
      1.5,
      b.size.d,
      wallOf(ctx, b, 0.7),
      0,
      0,
      0.5,
    );
  }
  const broken = shade(ctx.data.config.palette.sky, 0.5);
  for (const side of SIDES) {
    const s = faceOf(r, side);
    for (let u = -s.len / 2 + 1.5; u < s.len / 2 - 1; u += 2.2) {
      const lit = Math.abs(Math.sin(u * 12.9898 + b.position.x)) > 0.85;
      if (lit) ctx.glow.facePlane(s, u, h * 0.55, 1.4, 2, neon(ctx, b, 0.5));
      else ctx.solid.facePlane(s, u, h * 0.55, 1.4, 2, broken);
    }
  }
  // cheminée de brique, porte de quai
  ctx.solid.block(r.maxX - 1.5, 0, r.minZ + 1.5, 1.2, h + 5, 1.2, wallOf(ctx, b, 0.85));
  ctx.solid.faceBox(f, -f.len * 0.2, 2, 4, 4, 0.15, wallOf(ctx, b, 0.55));
  kit.door(f, f.len * 0.25, 1.2, 2.3, neon(ctx, b, 0.6));
}

/** Laverie : grande vitrine blanche, rangée de hublots de machines. */
function laundry(ctx: LandmarkCtx, kit: FacadeKit, b: Block, f: Face) {
  body(ctx, kit, b, b.door ?? 'south');
  shopfront(ctx, kit, b, f, neon(ctx, b, 0.45));
  const port = shade(ctx.data.config.palette.sky, 0.8);
  for (let u = -f.len * 0.35; u <= f.len * 0.2; u += 1)
    ctx.solid.faceBox(f, u, 0.9, 0.6, 0.6, 0.05, port, 0.08);
}

/** Barbier : vitrine chaude et enseigne tournante tricolore à côté de la porte. */
function barber(ctx: LandmarkCtx, kit: FacadeKit, b: Block, f: Face) {
  const { palette } = ctx.data.config;
  body(ctx, kit, b, b.door ?? 'south');
  shopfront(ctx, kit, b, f, shade(palette.neon, 0.7));
  const colors = [shade(palette.danger, 1.1), shade(palette.neon, 1.6), neon(ctx, b, 0.8)];
  for (let i = 0; i < 6; i++)
    ctx.glow.faceBox(f, -f.len / 2 + 0.6, 1 + i * 0.3, 0.3, 0.3, 0.3, colors[i % 3]!, 0.3);
}

/** Kebab : auvent rayé, vitrine jaune, broche lumineuse dans la vitrine. */
function kebab(ctx: LandmarkCtx, kit: FacadeKit, b: Block, f: Face) {
  const { palette } = ctx.data.config;
  body(ctx, kit, b, b.door ?? 'north');
  shopfront(ctx, kit, b, f, neon(ctx, b, 0.55));
  awning(ctx, f, f.len * 0.8, shade(palette.danger, 0.9), shade(palette.neon, 1.4));
  ctx.glow.faceBox(f, -f.len * 0.2, 1.5, 0.5, 1.6, 0.5, shade(palette.neon, 1.1), -0.4);
}

/** Commerce générique : vitrine, auvent, enseigne. */
function store(ctx: LandmarkCtx, kit: FacadeKit, b: Block, f: Face) {
  body(ctx, kit, b, b.door ?? 'south');
  shopfront(ctx, kit, b, f, neon(ctx, b, 0.4));
  awning(ctx, f, f.len * 0.6, wallOf(ctx, b, 0.6), neon(ctx, b, 0.5));
}

/**
 * Parking : sol sombre et lignes peintes, muret périphérique, guérite et barrière à l'entrée.
 * Les voitures garées sont instanciées (Decor) ; l'emprise entière reste un obstacle.
 */
function parking(ctx: LandmarkCtx, b: Block, f: Face) {
  const { palette } = ctx.data.config;
  const r = footprint(b);
  ctx.solid.floor(r, 0.05, shade(palette.street, 1.3));
  const line = shade(palette.neon, 1.6);
  const alongX = b.size.w >= b.size.d;
  const { width } = ctx.data.config.decor.carSize;
  const step = width + ctx.data.config.city.lotCars.gap;
  if (alongX)
    for (let x = r.minX + 1.2; x <= r.maxX - 1.2; x += step)
      ctx.solid.floor(
        { minX: x - 0.05, maxX: x + 0.05, minZ: r.minZ + 1, maxZ: r.maxZ - 1 },
        0.06,
        line,
      );
  else
    for (let z = r.minZ + 1.2; z <= r.maxZ - 1.2; z += step)
      ctx.solid.floor(
        { minX: r.minX + 1, maxX: r.maxX - 1, minZ: z - 0.05, maxZ: z + 0.05 },
        0.06,
        line,
      );
  const wall = wallOf(ctx, b, 1.2);
  for (const side of SIDES)
    ctx.solid.faceBox(faceOf(r, side), 0, 0.4, faceOf(r, side).len, 0.8, 0.3, wall, -0.15);
  // guérite et barrière rayée devant l'entrée
  ctx.solid.faceBox(f, -f.len / 2 + 2, 1.2, 1.8, 2.4, 1.6, wallOf(ctx, b, 1.5), -1);
  ctx.glow.faceBox(f, -f.len / 2 + 2, 2.6, 2, 0.5, 0.1, neon(ctx, b), -0.1);
  for (let i = 0; i < 6; i++)
    ctx.glow.faceBox(
      f,
      -f.len / 2 + 3.4 + i * 0.6,
      1.1,
      0.6,
      0.12,
      0.12,
      i % 2 ? shade(palette.danger, 1) : line,
      0.3,
    );
}

/** Couronne néon d'une tour et, si elle a une enseigne, caisson vertical à l'angle. */
export function towerTrim(ctx: LandmarkCtx, b: Block, front: DoorSide) {
  if (!b.neonColor) return;
  const r = footprint(b);
  for (const side of SIDES)
    ctx.glow.faceBox(
      faceOf(r, side),
      0,
      b.height - 0.35,
      faceOf(r, side).len,
      0.1,
      0.06,
      neon(ctx, b, 0.75),
      0.05,
    );
  if (!b.sign) return;
  const f = faceOf(r, front);
  const h = Math.min(8, b.height * 0.45);
  ctx.solid.faceBox(
    f,
    f.len / 2 - 0.6,
    b.height - h / 2 - 1,
    0.9,
    h,
    0.5,
    wallOf(ctx, b, 0.4),
    0.3,
  );
  ctx.glow.faceBox(f, f.len / 2 - 0.6, b.height - h / 2 - 1, 0.5, h - 0.6, 0.1, neon(ctx, b), 0.58);
}

/** Façade de repère d'un immeuble stylé (hors remplissage et tours). */
export function buildLandmark(ctx: LandmarkCtx, kit: FacadeKit, b: Block, front: DoorSide) {
  const f = faceOf(footprint(b), front);
  switch (b.style) {
    case 'police':
      return police(ctx, kit, b, f);
    case 'dealership':
      return dealership(ctx, kit, b, f);
    case 'gunshop':
      return gunshop(ctx, kit, b, f);
    case 'laundry':
      return laundry(ctx, kit, b, f);
    case 'barber':
      return barber(ctx, kit, b, f);
    case 'kebab':
      return kebab(ctx, kit, b, f);
    case 'store':
      return store(ctx, kit, b, f);
    case 'parking':
      return parking(ctx, b, f);
    case 'containers':
      return containers(ctx, kit, b, f);
    case 'factory':
      return factory(ctx, kit, b, f);
    default:
      return;
  }
}

/**
 * Panneaux d'entrée d'area (`config.map.areaGates`) : deux mâts sur les trottoirs, traverse
 * au-dessus de la route, liseré à la couleur de l'area. Décor sans collision.
 */
export function buildAreaGates(ctx: LandmarkCtx, kit: FacadeKit) {
  const { palette, map } = ctx.data.config;
  const post = shade(palette.wall, 0.6);
  kit.furniture(() => {
    for (const g of map.areaGates) {
      const area = ctx.data.areas.get(g.areaId);
      if (!area) continue;
      ctx.router?.at(g);
      const tint = shade(area.themeColor, 1);
      // la traverse est perpendiculaire au sens de la route
      const across = g.axis === 'x' ? { dx: 0, dz: 1 } : { dx: 1, dz: 0 };
      for (const s of [-1, 1])
        ctx.solid.block(
          g.x + across.dx * s * (g.span / 2),
          0,
          g.z + across.dz * s * (g.span / 2),
          0.35,
          g.height,
          0.35,
          post,
        );
      const [w, d] = g.axis === 'x' ? [0.4, g.span + 0.4] : [g.span + 0.4, 0.4];
      ctx.solid.block(g.x, g.height - 1.2, g.z, w, 1.2, d, shade(palette.sky, 0.8));
      ctx.glow.block(g.x, g.height - 1.25, g.z, w + 0.06, 0.08, d, tint);
      ctx.glow.block(g.x, g.height, g.z, w + 0.06, 0.08, d, tint);
    }
  });
}
