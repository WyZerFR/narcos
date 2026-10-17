import { airportLayout, kitModelled, type GameData, type Rect } from '@narco/shared';
import { faceOf, shade, type Batch } from './batch';
import type { FacadeKit } from './buildLandmarks';

/**
 * Aéroport fermé, fusionné dans les deux géométries de la ville : tarmac, piste et balisage,
 * hangars, clôture grillagée et portail. Le portail lit `locked` (battants fermés et néon rouge,
 * ou ouverts). Avions et conteneurs sont instanciés (Decor). Les constantes ne sont que du
 * gabarit de modélisation ; positions et tailles viennent de `config.airport`.
 */

interface Ctx {
  readonly solid: Batch;
  readonly glow: Batch;
  data: GameData;
}

const DASH = 4;
const LIGHT_STEP = 6;

function center(r: Rect) {
  return {
    x: (r.minX + r.maxX) / 2,
    z: (r.minZ + r.maxZ) / 2,
    w: r.maxX - r.minX,
    d: r.maxZ - r.minZ,
  };
}

export function buildAirport(ctx: Ctx, kit: FacadeKit) {
  const { palette, airport } = ctx.data.config;
  const area = ctx.data.areas.get(airport.areaId);
  if (!area) return;
  const l = airportLayout(airport, area);
  const { solid, glow } = ctx;

  kit.furniture(() => {
    // tarmac, piste, axe en pointillés et feux de bord
    solid.floor(l.inner, 0.03, shade(palette.street, 1.2));
    solid.floor(l.runway, 0.05, shade(palette.street, 0.8));
    const rw = center(l.runway);
    const alongX = rw.w >= rw.d;
    const len = alongX ? rw.w : rw.d;
    const paint = shade(palette.neon, 1.8);
    for (let t = 2; t + DASH < len - 2; t += DASH * 2) {
      const r: Rect = alongX
        ? {
            minX: l.runway.minX + t,
            maxX: l.runway.minX + t + DASH,
            minZ: rw.z - 0.2,
            maxZ: rw.z + 0.2,
          }
        : {
            minX: rw.x - 0.2,
            maxX: rw.x + 0.2,
            minZ: l.runway.minZ + t,
            maxZ: l.runway.minZ + t + DASH,
          };
      solid.floor(r, 0.06, paint);
    }
    const edgeLight = shade(palette.neon, 1.2);
    for (let t = 1; t < len; t += LIGHT_STEP)
      for (const s of [-1, 1]) {
        const x = alongX ? l.runway.minX + t : rw.x + (s * rw.w) / 2;
        const z = alongX ? rw.z + (s * rw.d) / 2 : l.runway.minZ + t;
        glow.block(x, 0, z, 0.25, 0.2, 0.25, edgeLight);
      }
  });

  // hangars : caisson, toit bombé en gradins, grande porte sur la face côté piste (sautés si
  // modélisés : `placements.kits.hangars`, PropKits)
  const metal = shade(palette.wall, 0.9);
  for (const h of kitModelled(ctx.data, 'hangars') ? [] : l.hangars) {
    const c = center(h);
    solid.block(c.x, 0, c.z, c.w, h.height - 2, c.d, metal);
    solid.block(c.x, h.height - 2, c.z, c.w, 1.2, c.d * 0.8, shade(palette.wall, 0.8));
    solid.block(c.x, h.height - 0.8, c.z, c.w, 0.8, c.d * 0.5, shade(palette.wall, 0.7));
    const side =
      Math.abs(c.z - center(l.runway).z) > Math.abs(c.x - center(l.runway).x)
        ? c.z > center(l.runway).z
          ? 'north'
          : 'south'
        : c.x > center(l.runway).x
          ? 'west'
          : 'east';
    const f = faceOf(h, side);
    glow.facePlane(f, 0, (h.height - 3) / 2, f.len * 0.7, h.height - 3, shade(palette.neon, 0.35));
    glow.faceBox(f, 0, h.height - 2.4, f.len * 0.4, 0.5, 0.1, shade(area.themeColor, 1), 0.1);
  }

  // clôture : poteaux réguliers, grillage sombre, liseré haut
  const { height, postSpacing } = airport.fence;
  const mesh = shade(palette.sky, 1.6);
  const post = shade(palette.wall, 0.5);
  kit.furniture(() => {
    for (const r of l.fence) {
      const c = center(r);
      solid.block(c.x, 0, c.z, c.w, height, c.d, mesh);
      solid.block(c.x, height, c.z, c.w + 0.1, 0.12, c.d + 0.1, post);
      const alongX = c.w >= c.d;
      const len = alongX ? c.w : c.d;
      for (let t = 0; t <= len; t += postSpacing) {
        const x = alongX ? r.minX + t : c.x;
        const z = alongX ? c.z : r.minZ + t;
        solid.block(x, 0, z, 0.2, height + 0.4, 0.2, post);
      }
    }
  });

  // portail : piliers, battants (fermés si verrouillé, sinon repliés contre les piliers), néon
  const g = center(l.gate);
  const gx = airport.gate.axis === 'x';
  const half = (gx ? g.w : g.d) / 2;
  const gh = airport.gate.height;
  const pillar = shade(palette.wall, 0.7);
  for (const s of [-1, 1])
    solid.block(
      gx ? g.x + s * (half + 0.4) : g.x,
      0,
      gx ? g.z : g.z + s * (half + 0.4),
      0.8,
      gh + 0.6,
      0.8,
      pillar,
    );
  const bars = shade(palette.wall, 1.3);
  const signColor = area.locked ? shade(palette.danger, 1.2) : shade(palette.ok, 1.1);
  if (area.locked) {
    for (let t = -half + 0.25; t < half; t += 0.5)
      solid.block(gx ? g.x + t : g.x, 0, gx ? g.z : g.z + t, 0.12, gh, 0.12, bars);
    for (const y of [0.4, gh / 2, gh - 0.2])
      solid.block(g.x, y, g.z, gx ? 2 * half : 0.16, 0.16, gx ? 0.16 : 2 * half, bars);
  } else {
    for (const s of [-1, 1])
      solid.block(
        gx ? g.x + s * (half - 0.2) : g.x - 1,
        0,
        gx ? g.z - 1 : g.z + s * (half - 0.2),
        gx ? 0.12 : 2,
        gh,
        gx ? 2 : 0.12,
        bars,
      );
  }
  glow.block(g.x, gh + 0.7, g.z, gx ? 2 * half : 0.2, 0.6, gx ? 0.2 : 2 * half, signColor);
}
