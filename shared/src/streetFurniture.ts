import { areaAt, areaContainsRect } from './areas';
import type { GameData } from './data';
import {
  expandRect,
  rectContainsPoint,
  rectFromCenter,
  rectsOverlap,
  type Rect,
  type Vec2,
} from './geometry';
import { interactionPoint } from './locations';
import type { QuartierLayout } from './quartiers';
import type { Area, GameConfig, GameLocation, Prop, PropPlacement } from './schemas';

/** Lampadaire de rue : pied au sol, rotation Y (bras vers la route). */
export interface StreetLamp extends Vec2 {
  rotY: number;
}

/** Un côté de route : bord (coordonnée hors route), sens de la normale vers la route. */
interface Side {
  road: Rect;
  alongX: boolean;
  /** Bord de la route de ce côté (z si alongX, x sinon) et signe vers l'extérieur. */
  edge: number;
  out: 1 | -1;
  /** Croisements à éviter (autres routes élargies). */
  crossings: Rect[];
}

function sides(config: GameConfig): Side[] {
  const { map } = config;
  const roads = map.roads.map((r) => rectFromCenter(r, r));
  return roads.flatMap((road, i): Side[] => {
    const crossings = roads
      .filter((_, j) => j !== i)
      .map((o) => expandRect(o, map.sidewalkWidth + 1));
    const alongX = road.maxX - road.minX >= road.maxZ - road.minZ;
    return alongX
      ? [
          { road, alongX, edge: road.minZ, out: -1 as const, crossings },
          { road, alongX, edge: road.maxZ, out: 1 as const, crossings },
        ]
      : [
          { road, alongX, edge: road.minX, out: -1 as const, crossings },
          { road, alongX, edge: road.maxX, out: 1 as const, crossings },
        ];
  });
}

/**
 * Côtés des impasses générées : bord extérieur de chaque trottoir (le trottoir et la placette
 * restent libres), normale opposée à la route voisine.
 */
function quartierSides(layouts: readonly QuartierLayout[]): Side[] {
  return layouts.flatMap((l) =>
    l.sidewalks.flatMap((sw): Side[] => {
      const alongX = sw.maxX - sw.minX >= sw.maxZ - sw.minZ;
      const c = alongX ? (sw.minZ + sw.maxZ) / 2 : (sw.minX + sw.maxX) / 2;
      // route la plus proche (une bande de stationnement peut les séparer)
      const road = [...l.roads].sort((a, b) => gap(a, sw) - gap(b, sw))[0];
      if (!road) return [];
      const rc = alongX ? (road.minZ + road.maxZ) / 2 : (road.minX + road.maxX) / 2;
      const out = c >= rc ? 1 : -1;
      const edge = alongX ? (out > 0 ? sw.maxZ : sw.minZ) : out > 0 ? sw.maxX : sw.minX;
      return [{ road: sw, alongX, edge, out, crossings: [] }];
    }),
  );
}

/** Rotation qui tourne l'avant (+Z) d'un objet du côté `s` vers la route. */
function towardRoad(s: Side): 0 | 90 | 180 | 270 {
  if (s.alongX) return s.out < 0 ? 0 : 180;
  return s.out < 0 ? 90 : 270;
}

/**
 * Lampadaires générés le long des routes, côté extérieur du trottoir, en quinconce, hors
 * croisements et à distance des portes (décor généré, ou `kits.lamps` modélisé).
 */
export function streetlightPlacements(data: Pick<GameData, 'config' | 'locations'>): StreetLamp[] {
  const { map, decor } = data.config;
  const doors = [...data.locations.values()].map(interactionPoint);
  const out: StreetLamp[] = [];
  const inset = map.sidewalkWidth - decor.streetlights.inset;
  sides(data.config).forEach((s, k) => {
    const off = s.edge + s.out * inset;
    const rotY = ((towardRoad(s) * Math.PI) / 180) as number;
    const from = s.alongX ? s.road.minX : s.road.minZ;
    const to = s.alongX ? s.road.maxX : s.road.maxZ;
    // décalage d'un demi-pas sur un côté sur deux : quinconce
    for (
      let t = from + decor.streetlights.spacing * (k % 2 ? 0.5 : 1);
      t < to - 1;
      t += decor.streetlights.spacing
    ) {
      const p = s.alongX ? { x: t, z: off } : { x: off, z: t };
      if (s.crossings.some((c) => rectContainsPoint(c, p))) continue;
      if (doors.some((dp) => Math.hypot(dp.x - p.x, dp.z - p.z) < 3)) continue;
      out.push({ ...p, rotY });
    }
  });
  return out;
}

const gap = (a: Rect, b: Rect) =>
  Math.hypot(
    Math.max(a.minX - b.maxX, 0, b.minX - a.maxX),
    Math.max(a.minZ - b.maxZ, 0, b.minZ - a.maxZ),
  );

/** Emprise au sol d'un prop (boîte, ou collision si présente) tourné d'un quart de tour. */
function boxOf(prop: Prop, p: Vec2, rotation: number, scale: number): Rect {
  const s = (prop.height / (prop.bounds.max[1] - prop.bounds.min[1])) * scale;
  let w = (prop.bounds.max[0] - prop.bounds.min[0]) * s;
  let d = (prop.bounds.max[2] - prop.bounds.min[2]) * s;
  if (Math.abs(Math.round(prop.rotationY / 90)) % 2 === 1) [w, d] = [d, w];
  if (rotation === 90 || rotation === 270) [w, d] = [d, w];
  return rectFromCenter(p, { w, d });
}

/**
 * Objets de la ville semés sur les trottoirs (`config.props.scatter`) : le long de chaque côté
 * de route, au pas de l'area, avant tourné vers la route, collés au bord du trottoir. Chaque
 * objet est vérifié comme un prop posé (`checkPlacements`) : dans son area, hors routes et
 * placettes, loin des portes, sans chevaucher d'obstacle ni un autre objet ; un objet à
 * collision laisse au moins un diamètre + marge avec tout obstacle (aucune fente). Le premier
 * objet après un croisement est celui de l'angle (`corner` : feu tricolore).
 * `obstacles` : obstacles de la rue avec les props posés à la main.
 */
export function scatterPlacements(
  config: GameConfig,
  props: ReadonlyMap<string, Prop>,
  areas: ReadonlyMap<string, Area>,
  locations: Iterable<GameLocation>,
  layouts: Iterable<QuartierLayout>,
  obstacles: readonly Rect[],
): (PropPlacement & { areaId: string })[] {
  const { scatter, doorClearance } = config.props;
  const layoutList = [...layouts];
  const roads = [
    ...config.map.roads.map((r) => rectFromCenter(r, r)),
    ...layoutList.flatMap((l) => [...l.roads, ...l.sidewalks, ...l.parking, l.plaza]),
  ];
  const doors = [
    ...[...locations].map(interactionPoint),
    ...layoutList.flatMap((l) => l.houses.map((h) => h.doorStep)),
  ];
  const lamps = streetlightPlacements({ config, locations: new Map() }).map((l) =>
    rectFromCenter(l, { w: 0.4, d: 0.4 }),
  );
  const minGap = 2 * config.world.playerRadius + config.collision.passageMargin;
  const areaList = [...areas.values()];
  const counters = new Map<string, number>();
  const placed: Rect[] = [];
  const solid: Rect[] = [];
  const out: (PropPlacement & { areaId: string })[] = [];
  for (const s of [...sides(config), ...quartierSides(layoutList)]) {
    const from = s.alongX ? s.road.minX : s.road.minZ;
    const to = s.alongX ? s.road.maxX : s.road.maxZ;
    const rotation = towardRoad(s);
    let afterCrossing = true;
    for (let t = from + scatter.phase; t < to - 1;) {
      const probe = s.alongX ? { x: t, z: s.edge } : { x: s.edge, z: t };
      if (s.crossings.some((c) => rectContainsPoint(c, probe))) {
        afterCrossing = true;
        t += 1;
        continue;
      }
      const area = areaAt(areaList, probe);
      const cfg = area ? scatter.areas[area.id] : undefined;
      if (!area || !cfg) {
        t += 1;
        continue;
      }
      const n = counters.get(area.id) ?? 0;
      const id = afterCrossing && cfg.corner ? cfg.corner : cfg.props[n % cfg.props.length]!;
      const prop = props.get(id);
      if (!prop) {
        t += 1;
        continue;
      }
      // profondeur le long de la normale : pied du côté route au retrait `curbInset`
      const box0 = boxOf(prop, { x: 0, z: 0 }, rotation, 1);
      const depth = s.alongX ? box0.maxZ - box0.minZ : box0.maxX - box0.minX;
      const off = s.edge + s.out * (scatter.curbInset + depth / 2);
      const p = s.alongX ? { x: t, z: off } : { x: off, z: t };
      const r = boxOf(prop, p, rotation, 1);
      const hit = prop.collision
        ? (o: Rect) => gap(o, r) < minGap
        : (o: Rect) => rectsOverlap(o, r);
      const ok =
        areaContainsRect(area, r) &&
        !roads.some((road) => rectsOverlap(road, r)) &&
        !doors.some((d) => gap(rectFromCenter(d, { w: 0, d: 0 }), r) < doorClearance) &&
        !obstacles.some(hit) &&
        !solid.some(hit) &&
        !placed.some((o) => rectsOverlap(o, r)) &&
        !lamps.some((o) => rectsOverlap(o, r));
      if (!ok) {
        t += 1;
        continue;
      }
      out.push({ prop: id, x: p.x, z: p.z, rotation, scale: 1, areaId: area.id });
      placed.push(r);
      if (prop.collision) solid.push(r);
      if (!(afterCrossing && cfg.corner)) counters.set(area.id, n + 1);
      afterCrossing = false;
      t += cfg.spacing;
    }
  }
  return out;
}
