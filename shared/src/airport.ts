import { rectFromCenter, rectsOverlap, type Rect, type Vec2 } from './geometry';
import type { AirportParams, Area } from './schemas';

/**
 * Aéroport (logique pure) : clôture en retrait du bord de l'area, portail, piste, hangars, avions
 * et conteneurs. La collision et le rendu lisent tous deux `area.locked` : verrouillé, l'area
 * entière est hors-zone et le portail reste un obstacle fermé ; déverrouillé (progression ou
 * debug), seuls la clôture (ouverte au portail) et les volumes au sol bloquent.
 */

export interface AirportLayout {
  /** Intérieur de la clôture. */
  inner: Rect;
  /** Tronçons de clôture (le portail en est retiré). */
  fence: Rect[];
  gate: Rect;
  runway: Rect;
  hangars: (Rect & { height: number })[];
  planes: (Vec2 & { rotY: number })[];
  /** Emprise au sol d'un avion (fuselage), pour la collision une fois ouvert. */
  planeRects: Rect[];
  containers: (Vec2 & { rotY: number; stack: number; color: string })[];
  containerRects: Rect[];
}

/** Retire de `r` la partie couverte par `cut` le long de l'axe `axis` (0, 1 ou 2 morceaux). */
function cutAlong(r: Rect, cut: Rect, axis: 'x' | 'z'): Rect[] {
  if (!rectsOverlap(r, cut)) return [r];
  const out =
    axis === 'x'
      ? [
          { ...r, maxX: Math.min(r.maxX, cut.minX) },
          { ...r, minX: Math.max(r.minX, cut.maxX) },
        ]
      : [
          { ...r, maxZ: Math.min(r.maxZ, cut.minZ) },
          { ...r, minZ: Math.max(r.minZ, cut.maxZ) },
        ];
  return out.filter((p) => p.maxX - p.minX > 1e-6 && p.maxZ - p.minZ > 1e-6);
}

export function airportLayout(p: AirportParams, area: Area): AirportLayout {
  const b = area.bounds;
  const t = p.fence.thickness;
  const inner: Rect = {
    minX: b.minX + p.fence.inset,
    maxX: b.maxX - p.fence.inset,
    minZ: b.minZ + p.fence.inset,
    maxZ: b.maxZ - p.fence.inset,
  };
  const gate = rectFromCenter(
    p.gate,
    p.gate.axis === 'x'
      ? { w: p.gate.width, d: p.gate.depth }
      : { w: p.gate.depth, d: p.gate.width },
  );
  const sides: { r: Rect; axis: 'x' | 'z' }[] = [
    { r: { ...inner, maxZ: inner.minZ, minZ: inner.minZ - t }, axis: 'x' },
    { r: { ...inner, minZ: inner.maxZ, maxZ: inner.maxZ + t }, axis: 'x' },
    { r: { ...inner, maxX: inner.minX, minX: inner.minX - t }, axis: 'z' },
    { r: { ...inner, minX: inner.maxX, maxX: inner.maxX + t }, axis: 'z' },
  ];
  const fence = sides.flatMap((s) => cutAlong(s.r, gate, s.axis));
  const { length, span } = p.planeSize;
  const planes = p.planes.map((pl) => ({ x: pl.x, z: pl.z, rotY: (-pl.heading * Math.PI) / 180 }));
  const planeRects = p.planes.map((pl) => {
    const along = Math.abs(Math.cos((pl.heading * Math.PI) / 180)) >= Math.SQRT1_2;
    // fuselage élargi au quart de l'envergure (emplanture des ailes), cap arrondi à l'axe
    const fus = along ? { w: length, d: span / 4 } : { w: span / 4, d: length };
    return rectFromCenter(pl, fus);
  });
  const c = p.containerSize;
  const containers = p.containers.map((k) => ({
    x: k.x,
    z: k.z,
    rotY: k.rotation === 90 ? Math.PI / 2 : 0,
    stack: k.stack,
    color: k.color,
  }));
  const containerRects = p.containers.map((k) =>
    rectFromCenter(k, k.rotation === 0 ? { w: c.length, d: c.width } : { w: c.width, d: c.length }),
  );
  return {
    inner,
    fence,
    gate,
    runway: rectFromCenter(p.runway, p.runway),
    hangars: p.hangars.map((h) => ({ ...rectFromCenter(h, h), height: h.height })),
    planes,
    planeRects,
    containers,
    containerRects,
  };
}

/**
 * Obstacles de l'aéroport selon `locked` : fermé, le portail (l'area entière est déjà hors-zone
 * via `outsideAreas`) ; ouvert, clôture, hangars, avions et conteneurs.
 */
export function airportObstacles(p: AirportParams, areas: ReadonlyMap<string, Area>): Rect[] {
  const area = areas.get(p.areaId);
  if (!area) return [];
  const l = airportLayout(p, area);
  if (area.locked) return [l.gate];
  return [...l.fence, ...l.hangars, ...l.planeRects, ...l.containerRects];
}
