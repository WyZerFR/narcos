import { footprint } from './locations';
import { rectContainsRect, rectFromCenter, type Rect, type Vec2 } from './geometry';
import type {
  Area,
  Bounds,
  GameLocation,
  QuartierColliders,
  QuartierParams,
  Roof,
} from './schemas';

/**
 * Quartiers en impasse (`quartiers.json`) : repère géométrique d'une impasse et, plus bas,
 * générateur déterministe des maisons et du décor. Pur : même entrée, même résultat sur le
 * client et le serveur.
 */

/**
 * Repère d'une impasse : elle part du bord de l'area collé à la rue et s'enfonce selon `dir`
 * (-1 = vers -Z, quartier nord ; +1 = vers +Z, quartier sud), le long de l'axe x = `axisX`.
 * Les distances `t` se mesurent depuis l'entrée.
 */
export interface QuartierFrame {
  dir: 1 | -1;
  axisX: number;
  entranceZ: number;
  /** Demi-largeur chaussée + stationnement, puis bord extérieur du trottoir. */
  roadwayHalf: number;
  sidewalkOuter: number;
  housesStart: number;
  housesEnd: number;
  /** Fin de la placette = façade du bâtiment du bout. */
  plazaEnd: number;
}

/** Repère de l'impasse, ou null si l'area ne touche pas la rue au nord ou au sud. */
export function quartierFrame(
  q: QuartierParams,
  area: Bounds,
  street: Bounds,
): QuartierFrame | null {
  const dir = area.maxZ === street.minZ ? -1 : area.minZ === street.maxZ ? 1 : null;
  if (dir === null) return null;
  const s = q.street;
  const roadwayHalf = s.roadWidth / 2 + s.parkingWidth;
  const housesStart = s.entranceClear;
  const housesEnd = housesStart + s.housesLength;
  return {
    dir,
    axisX: (area.minX + area.maxX) / 2,
    entranceZ: dir < 0 ? area.maxZ : area.minZ,
    roadwayHalf,
    sidewalkOuter: roadwayHalf + s.sidewalkWidth,
    housesStart,
    housesEnd,
    plazaEnd: housesEnd + s.plazaDepth,
  };
}

/** Coordonnée z à la distance `t` de l'entrée. */
export const alongZ = (f: QuartierFrame, t: number) => f.entranceZ + f.dir * t;

/** Rectangle entre les distances `t0` et `t1`, sur |x − axe| ≤ `half`. */
export function bandRect(f: QuartierFrame, t0: number, t1: number, half: number): Rect {
  const a = alongZ(f, t0);
  const b = alongZ(f, t1);
  return {
    minX: f.axisX - half,
    maxX: f.axisX + half,
    minZ: Math.min(a, b),
    maxZ: Math.max(a, b),
  };
}

/** Cohérence d'une impasse avec son area et son bâtiment du bout. */
export function checkQuartier(
  q: QuartierParams,
  areas: ReadonlyMap<string, Area>,
  locations: ReadonlyMap<string, GameLocation>,
): string[] {
  const where = `quartiers.json : "${q.id}"`;
  const area = areas.get(q.areaId);
  const street = areas.get('street');
  if (!area || !street || area.id === 'street') return [`${where} : area "${q.areaId}" inconnue`];
  const f = quartierFrame(q, area.bounds, street.bounds);
  if (!f) return [`${where} : l'area "${area.id}" doit toucher la rue au nord ou au sud`];
  const errors: string[] = [];
  const h = q.houses;
  const deepest = f.sidewalkOuter + h.setback[1] + h.depth[1];
  if (!rectContainsRect(area.bounds, bandRect(f, 0, f.plazaEnd, deepest)))
    errors.push(`${where} : les maisons débordent de l'area "${area.id}"`);
  if (q.street.housesLength / h.perSide[1] < h.width[0] + h.gap[0])
    errors.push(`${where} : housesLength trop court pour perSide max (largeur + écart min)`);
  if (q.street.plazaWidth / 2 < f.sidewalkOuter)
    errors.push(`${where} : la placette doit être au moins aussi large que la rue`);
  const loc = locations.get(q.landmarkLocationId);
  if (!loc || loc.kind !== 'building')
    return [...errors, `${where} : bâtiment du bout "${q.landmarkLocationId}" inconnu`];
  const r = footprint(loc);
  const front = f.dir < 0 ? r.maxZ : r.minZ;
  if (Math.abs(loc.position.x - f.axisX) > 0.01)
    errors.push(`${where} : "${loc.id}" doit être centré sur l'axe x = ${f.axisX}`);
  if (Math.abs(front - alongZ(f, f.plazaEnd)) > 0.01)
    errors.push(`${where} : la façade de "${loc.id}" doit être en z = ${alongZ(f, f.plazaEnd)}`);
  if (loc.door !== (f.dir < 0 ? 'south' : 'north'))
    errors.push(`${where} : la porte de "${loc.id}" doit regarder la rue`);
  if (!rectContainsRect(area.bounds, r))
    errors.push(`${where} : "${loc.id}" déborde de l'area "${area.id}"`);
  return errors;
}

// ---------------------------------------------------------------- générateur

/** Hasard déterministe (mulberry32) à partir d'une graine texte : identique client / serveur. */
export function seededRng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface HouseWindow {
  /** Décalage le long de la façade (axe Z monde) depuis le centre de la maison. */
  u: number;
  /** 0 = rez-de-chaussée, 1 = étage. */
  floor: number;
  lit: boolean;
}

/** Maison décorative (non enterable) le long de l'impasse. */
export interface House {
  id: string;
  /** -1 = côté ouest de l'axe, +1 = côté est. */
  side: -1 | 1;
  rect: Rect;
  /** Hauteur des murs (rez-de-chaussée + étage éventuel). */
  height: number;
  floors: 1 | 2;
  roof: Roof;
  facade: string;
  roofColor: string;
  doorColor: string;
  /** Façade sur rue (x) et porte : centre au sol, devant la façade. */
  frontX: number;
  door: Vec2;
  /** Point sur le trottoir devant la porte (accès piéton). */
  doorStep: Vec2;
  /** Décalage de la porte de garage le long de la façade, ou null. */
  garageU: number | null;
  porch: boolean;
  windows: HouseWindow[];
}

export interface ParkedCar {
  x: number;
  z: number;
  /** Rotation Y (rad) : voitures garées dans l'axe de la rue. */
  rotY: number;
}

export interface Garland {
  a: Vec2;
  b: Vec2;
  y: number;
}

/** Impasse générée : sol, maisons, décor, collisions. */
export interface QuartierLayout {
  id: string;
  areaId: string;
  frame: QuartierFrame;
  /** Chaussée roulante (toujours libre), bandes de stationnement, trottoirs, placette. */
  road: Rect;
  parking: Rect[];
  sidewalks: Rect[];
  plaza: Rect;
  houses: House[];
  lamps: Vec2[];
  trees: Vec2[];
  bins: Vec2[];
  crates: Vec2[];
  cars: ParkedCar[];
  fences: Rect[];
  garlands: Garland[];
  /** Arche d'entrée : deux piliers et l'enseigne. */
  arch: { left: Vec2; right: Vec2; height: number; label: string };
  /** Gardes statiques devant le bâtiment du bout (décor, sans collision). */
  guards: Vec2[];
  /** Portail devant le bâtiment du bout (décor), ou null. */
  gate: { left: Vec2; right: Vec2 } | null;
  /** Tout ce qui bloque joueurs et PNJ : maisons et décor solide. */
  colliders: Rect[];
  /** Points de passage des PNJ du quartier (chaussée et placette, toujours libres). */
  waypoints: Vec2[];
}

const between = (rng: () => number, [min, max]: readonly [number, number]) =>
  min + (max - min) * rng();
const pick = <T>(rng: () => number, list: readonly T[]): T =>
  list[Math.min(list.length - 1, Math.floor(rng() * list.length))]!;

/** Gabarits de modélisation (m) : porte, garage, fenêtres. */
const DOOR_W = 1.1;
const GARAGE_W = 2.4;
const WINDOW_STEP = 2.2;
const WINDOW_MARGIN = 0.9;

/**
 * Génère une impasse : maisons des deux côtés, placette au fond, décor. Pur et déterministe
 * (la graine fixe tous les tirages). `car` = gabarit des voitures (config.decor.carSize).
 */
export function generateQuartier(
  q: QuartierParams,
  frame: QuartierFrame,
  colliders: QuartierColliders,
  car: { length: number; width: number },
): QuartierLayout {
  const rng = seededRng(q.seed);
  const f = frame;
  const H = q.houses;
  const D = q.decor;
  const s = q.street;
  const z = (t: number) => alongZ(f, t);
  const square = (p: Vec2, size: number) => rectFromCenter(p, { w: size, d: size });

  const houses: House[] = [];
  const lamps: Vec2[] = [];
  const trees: Vec2[] = [];
  const bins: Vec2[] = [];
  const crates: Vec2[] = [];
  const cars: ParkedCar[] = [];
  const fences: Rect[] = [];
  const garlands: Garland[] = [];

  for (const side of [-1, 1] as const) {
    const n = Math.round(between(rng, H.perSide));
    const slot = s.housesLength / n;
    const lampX = f.axisX + side * (f.sidewalkOuter - colliders.lampSize);
    let lastLamp = -Infinity;
    const addLamp = (t: number) => {
      if (t - lastLamp < D.streetlightSpacing) return;
      lamps.push({ x: lampX, z: z(t) });
      lastLamp = t;
    };
    addLamp(f.housesStart + colliders.lampSize);
    for (let k = 0; k < n; k++) {
      const gap = between(rng, H.gap);
      const w = Math.max(H.width[0], Math.min(between(rng, H.width), slot - gap));
      const t0 = f.housesStart + k * slot + (slot - w) / 2;
      const setback = between(rng, H.setback);
      const depth = between(rng, H.depth);
      const frontX = f.axisX + side * (f.sidewalkOuter + setback);
      const backX = frontX + side * depth;
      const za = z(t0);
      const zb = z(t0 + w);
      const rect: Rect = {
        minX: Math.min(frontX, backX),
        maxX: Math.max(frontX, backX),
        minZ: Math.min(za, zb),
        maxZ: Math.max(za, zb),
      };
      const floors: 1 | 2 = rng() < H.storeyChance ? 2 : 1;
      const garage = rng() < H.garageChance;
      // porte décalée quand il y a un garage ; u le long de +Z monde
      const doorU = garage ? -w / 4 : 0;
      const garageU = garage ? w / 4 : null;
      const zc = (rect.minZ + rect.maxZ) / 2;
      const door = { x: frontX, z: zc + doorU };
      const windows: HouseWindow[] = [];
      for (let floor = 0; floor < floors; floor++)
        for (let u = -w / 2 + WINDOW_MARGIN; u <= w / 2 - WINDOW_MARGIN + 1e-6; u += WINDOW_STEP) {
          if (floor === 0 && Math.abs(u - doorU) < DOOR_W) continue;
          if (floor === 0 && garageU !== null && Math.abs(u - garageU) < GARAGE_W / 2 + 0.6)
            continue;
          windows.push({ u, floor, lit: rng() < H.windowLitChance });
        }
      houses.push({
        id: `${q.id}_${side < 0 ? 'o' : 'e'}${k + 1}`,
        side,
        rect,
        height: between(rng, H.height) + (floors === 2 ? H.storeyHeight : 0),
        floors,
        roof: pick(rng, H.roofs),
        facade: pick(rng, q.palette.facades),
        roofColor: pick(rng, q.palette.roofs),
        doorColor: pick(rng, q.palette.doors),
        frontX,
        door,
        doorStep: { x: f.axisX + side * (f.roadwayHalf + s.sidewalkWidth / 2), z: door.z },
        garageU,
        porch: rng() < H.porchChance,
        windows,
      });

      // décor du jardinet (entre trottoir et façade), jamais devant la porte
      const yardX = f.axisX + side * (f.sidewalkOuter + setback / 2);
      if (rng() < D.binChance) bins.push({ x: yardX, z: rect.minZ + 0.6 });
      if (rng() < D.crateChance) crates.push({ x: yardX, z: rect.maxZ - 0.6 });
      if (!garage && rng() < D.fenceChance) {
        const fx = f.axisX + side * (f.sidewalkOuter + colliders.fenceThickness / 2);
        const half = colliders.fenceDoorGap / 2;
        const segs: [number, number][] = [
          [rect.minZ, door.z - half],
          [door.z + half, rect.maxZ],
        ];
        for (const [a, b] of segs)
          if (b - a > 0.3)
            fences.push({
              minX: fx - colliders.fenceThickness / 2,
              maxX: fx + colliders.fenceThickness / 2,
              minZ: a,
              maxZ: b,
            });
      }
      // trottoir côté bordure : arbre ; stationnement : voiture
      if (rng() < D.treeChance)
        trees.push({
          x: f.axisX + side * (f.roadwayHalf + colliders.trunkSize),
          z: zc + (doorU > 0 ? -1 : 1) * (w / 4),
        });
      if (rng() < D.carChance && w >= car.length)
        cars.push({
          x: f.axisX + side * (s.roadWidth / 2 + s.parkingWidth / 2),
          z: zc,
          rotY: Math.PI / 2,
        });
      // lampadaire dans l'écart avec la maison suivante (jamais sur la placette)
      addLamp(Math.min(f.housesStart + (k + 1) * slot, f.housesEnd - colliders.lampSize));
    }
  }

  // placette : lampadaires aux angles, guirlandes, gardes et portail devant le bâtiment du bout
  const plaza = bandRect(f, f.housesEnd, f.plazaEnd, s.plazaWidth / 2);
  for (const side of [-1, 1])
    lamps.push({
      x: f.axisX + side * (s.plazaWidth / 2 + colliders.lampSize),
      z: z(f.plazaEnd - colliders.lampSize),
    });
  if (D.garlandSpacing > 0)
    for (let t = f.housesStart; t <= f.housesEnd; t += D.garlandSpacing)
      garlands.push({
        a: { x: f.axisX - f.sidewalkOuter, z: z(t) },
        b: { x: f.axisX + f.sidewalkOuter, z: z(t) },
        y: q.arch.height - 0.5,
      });
  if (q.landmark.garlands)
    for (const t of [f.housesEnd + 1, f.plazaEnd - 1])
      garlands.push({
        a: { x: f.axisX - s.plazaWidth / 2, z: z(t) },
        b: { x: f.axisX + s.plazaWidth / 2, z: z(t) },
        y: q.arch.height - 1,
      });
  const guards = Array.from({ length: q.landmark.guards }, (_, i) => ({
    x: f.axisX + (i % 2 === 0 ? -1 : 1) * (2.2 + Math.floor(i / 2) * 1.2),
    z: z(f.plazaEnd - 0.8),
  }));
  const gate = q.landmark.gate
    ? {
        left: { x: f.axisX - f.sidewalkOuter, z: z(f.plazaEnd - 3) },
        right: { x: f.axisX + f.sidewalkOuter, z: z(f.plazaEnd - 3) },
      }
    : null;
  const archZ = z(s.entranceClear / 2);
  const arch = {
    left: { x: f.axisX - f.sidewalkOuter - 0.5, z: archZ },
    right: { x: f.axisX + f.sidewalkOuter + 0.5, z: archZ },
    height: q.arch.height,
    label: q.arch.label,
  };

  const carSize = { w: car.width, d: car.length };
  const colliderRects: Rect[] = [
    ...houses.map((h) => h.rect),
    ...lamps.map((p) => square(p, colliders.lampSize)),
    ...trees.map((p) => square(p, colliders.trunkSize)),
    ...bins.map((p) => rectFromCenter(p, colliders.binSize)),
    ...crates.map((p) => square(p, colliders.crateSize)),
    ...cars.map((c) => rectFromCenter(c, carSize)),
    ...fences,
  ];
  // bandes symétriques de part et d'autre de l'axe, entre deux demi-largeurs
  const strips = (inner: number, outer: number): Rect[] => {
    const r = bandRect(f, 0, f.housesEnd, outer);
    return [
      { ...r, maxX: f.axisX - inner },
      { ...r, minX: f.axisX + inner },
    ];
  };
  const sidewalks = strips(f.roadwayHalf, f.sidewalkOuter);
  const parking = strips(s.roadWidth / 2, f.roadwayHalf);
  return {
    id: q.id,
    areaId: q.areaId,
    frame: f,
    road: bandRect(f, 0, f.housesEnd, s.roadWidth / 2),
    parking,
    sidewalks,
    plaza,
    houses,
    lamps,
    trees,
    bins,
    crates,
    cars,
    fences,
    garlands,
    arch,
    guards,
    gate,
    colliders: colliderRects,
    waypoints: npcWaypoints(f, s),
  };
}

/** Points de passage des PNJ : de part et d'autre de l'axe de la chaussée, puis la placette. */
function npcWaypoints(f: QuartierFrame, s: QuartierParams['street']): Vec2[] {
  const out: Vec2[] = [];
  const lane = s.roadWidth / 4;
  for (let t = s.npcWaypointSpacing / 2; t < f.housesEnd; t += s.npcWaypointSpacing)
    for (const side of [-1, 1]) out.push({ x: f.axisX + side * lane, z: alongZ(f, t) });
  const mid = (f.housesEnd + f.plazaEnd) / 2;
  for (const dx of [-s.plazaWidth / 4, 0, s.plazaWidth / 4])
    out.push({ x: f.axisX + dx, z: alongZ(f, mid) });
  return out;
}
