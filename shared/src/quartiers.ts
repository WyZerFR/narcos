import { footprint } from './locations';
import { isNarrowGap, rectContainsRect, rectFromCenter, type Rect, type Vec2 } from './geometry';
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
    axisX: s.axisX,
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
  for (const [i, hc] of q.hiddenGardens.entries()) {
    // deux jardins d'un même côté : maisons distinctes (le nombre de maisons générées est
    // vérifié au chargement, après génération)
    for (const other of q.hiddenGardens.slice(i + 1))
      if (other.side === hc.side && Math.abs(other.houseIndex - hc.houseIndex) < 2)
        errors.push(`${where} : deux jardins cachés partagent une maison (${hc.side})`);
    if (q.street.housesLength / h.perSide[1] - hc.passageWidth < h.width[0])
      errors.push(
        `${where} : pas la place d'un passage de ${hc.passageWidth} m entre deux maisons`,
      );
    const garden = f.sidewalkOuter + h.setback[1] + h.depth[1] + hc.gardenDepth + 1;
    const edge = hc.side === 'west' ? f.axisX - area.bounds.minX : area.bounds.maxX - f.axisX;
    if (garden > edge)
      errors.push(
        `${where} : jardin caché hors de l'area "${area.id}" (élargir son côté ${hc.side})`,
      );
  }
  if (q.hiddenGardens.length > 0 && !q.cellarLocationId)
    errors.push(`${where} : cellarLocationId obligatoire avec des jardins cachés`);
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
  /** Vrai jardin caché (trappe de la cave du blanchisseur), ou null. */
  cellar: HiddenGardenLayout | null;
  /** Tous les jardins cachés : le vrai et les leurres, indiscernables depuis la rue. */
  gardens: HiddenGardenLayout[];
  /** Remblai plein derrière les maisons des côtés à jardins (hors jardins et clôtures). */
  gardenBackfill: Rect[];
  /** Zones interdites aux PNJ de vente (passages et jardins cachés). */
  npcBlocked: Rect[];
}

/** Passage entre deux maisons et jardin arrière clos : le vrai (trappe) ou un leurre. */
export interface HiddenGardenLayout {
  kind: 'real' | 'decoy';
  side: -1 | 1;
  /** Passage piéton entre les deux maisons, du trottoir à la ligne de fond. */
  passage: Rect;
  /** Jardin derrière les deux maisons (libre, hors clôtures). */
  garden: Rect;
  /** Emplacement central : la trappe (vrai jardin) ou le coffre cassé (leurre). */
  spot: Vec2;
  /** Trappe de la cave : seulement dans le vrai jardin. */
  trapdoor: Vec2 | null;
  /** Coffre cassé à la place de la trappe : seulement dans un leurre. */
  brokenChest: Vec2 | null;
  /** Clôtures du jardin (côtés et fond), hauteur `fenceHeight`. */
  fences: Rect[];
  fenceHeight: number;
  /** Décor solide du jardin (placé par la graine du jardin). */
  crates: Vec2[];
  bins: Vec2[];
  armchair: Vec2;
  solids: Rect[];
  /** Ampoule nue près de l'emplacement central (décor émissif). */
  bulb: Vec2;
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
  area: Bounds,
  /** Écart minimal entre deux obstacles qui ne se touchent pas (diamètre du joueur + marge). */
  minGap: number,
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

  // jardins cachés : maisons k et k+1 d'un côté, alignées au fond sur `backLine`, passage entre
  // elles ; `gardenOf(side, k)` = entrée de hiddenGardens qui utilise cette maison
  const sideOf = (g: { side: 'west' | 'east' }): -1 | 1 => (g.side === 'east' ? 1 : -1);
  const backLine = f.sidewalkOuter + H.setback[1] + H.depth[1];
  const gardenOf = (side: -1 | 1, k: number) =>
    q.hiddenGardens.findIndex(
      (g) => sideOf(g) === side && (k === g.houseIndex || k === g.houseIndex + 1),
    );
  const spans = q.hiddenGardens.map(() => [] as { t0: number; t1: number }[]);

  for (const side of [-1, 1] as const) {
    const n = Math.round(between(rng, H.perSide));
    const slot = s.housesLength / n;
    // lampadaires contre la bordure (le trottoir reste libre côté jardinets)
    const lampX = f.axisX + side * (f.roadwayHalf + colliders.lampSize / 2);
    // ligne de fond de ce côté : remblai (côté à jardins) ou bord de l'area
    const hasGardens = q.hiddenGardens.some((g) => sideOf(g) === side);
    const wallLine = hasGardens ? backLine : side < 0 ? f.axisX - area.minX : area.maxX - f.axisX;
    let lastLamp = -Infinity;
    const addLamp = (t: number) => {
      if (t - lastLamp < D.streetlightSpacing) return;
      lamps.push({ x: lampX, z: z(t) });
      lastLamp = t;
    };
    addLamp(f.housesStart + colliders.lampSize);
    for (let k = 0; k < n; k++) {
      const gi = gardenOf(side, k);
      const hc = gi >= 0 ? q.hiddenGardens[gi] : undefined;
      const gap = between(rng, H.gap);
      const drawnW = Math.max(H.width[0], Math.min(between(rng, H.width), slot - gap));
      // maisons de la cachette : assez étroites pour laisser le passage entre elles
      const w = hc ? Math.min(drawnW, slot - hc.passageWidth) : drawnW;
      const t0 = f.housesStart + k * slot + (slot - w) / 2;
      const setback = between(rng, H.setback);
      const drawnDepth = between(rng, H.depth);
      // …et profondes jusqu'à la ligne de fond : leurs murs ferment le jardin côté rue
      // maison collée au fond si la fente qui resterait derrière serait plus étroite qu'un passage
      const slit = wallLine - (f.sidewalkOuter + setback + drawnDepth);
      const toWall = slit > 0 && slit < minGap;
      const depth = hc
        ? backLine - f.sidewalkOuter - setback
        : toWall
          ? wallLine - f.sidewalkOuter - setback
          : drawnDepth;
      if (hc) spans[gi]!.push({ t0, t1: t0 + w });
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

      // décor du jardinet, collé à la façade (jamais devant la porte) ; tirages dans l'ordre
      // d'origine, décisions ensuite (clôture connue avant de poser poubelle et caisse)
      const binRoll = rng();
      const crateRoll = rng();
      const fenced = !garage && rng() < D.fenceChance;
      const yardFree = setback - (fenced ? colliders.fenceThickness : 0);
      const flush = (size: number) => frontX - side * (size / 2);
      const fits = (size: number) => !fenced || yardFree - size >= minGap;
      if (binRoll < D.binChance && fits(colliders.binSize.w))
        bins.push({ x: flush(colliders.binSize.w), z: rect.minZ + 0.6 });
      if (crateRoll < D.crateChance && fits(colliders.crateSize))
        crates.push({ x: flush(colliders.crateSize), z: rect.maxZ - 0.6 });
      if (fenced) {
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
      // trottoir côté bordure : arbre ; stationnement : voiture (pas d'arbre derrière une voiture)
      const treeRoll = rng();
      const parked = rng() < D.carChance && w >= car.length;
      if (treeRoll < D.treeChance && !parked)
        trees.push({
          x: f.axisX + side * (f.roadwayHalf + colliders.trunkSize / 2),
          z: zc + (doorU > 0 ? -1 : 1) * (w / 4),
        });
      if (parked)
        cars.push({
          x: f.axisX + side * (s.roadWidth / 2 + s.parkingWidth / 2),
          z: zc,
          rotY: Math.PI / 2,
        });
      // lampadaire dans l'écart avec la maison suivante (jamais sur la placette ni devant
      // l'entrée du passage caché)
      if (!(hc && k === hc.houseIndex))
        addLamp(Math.min(f.housesStart + (k + 1) * slot, f.housesEnd - colliders.lampSize));
    }
  }

  // jardins dont les deux maisons existent (sinon absents : signalé au chargement)
  const gardens = q.hiddenGardens.flatMap((g, i) =>
    spans[i]!.length === 2
      ? [
          hiddenGarden(
            f,
            sideOf(g),
            backLine,
            spans[i]!,
            g,
            colliders,
            seededRng(`${q.seed}:jardin:${i}`),
          ),
        ]
      : [],
  );
  const gardenBackfill = ([-1, 1] as const).flatMap((side) =>
    backfillFor(
      f,
      side,
      backLine,
      gardens.filter((g) => g.side === side),
      colliders,
      area,
    ),
  );
  for (const g of gardens) fences.push(...g.fences);
  const cellar = gardens.find((g) => g.kind === 'real') ?? null;

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
  // dégagement : un petit décor qui laisserait une fente (plus étroite qu'un passage) avec un
  // obstacle déjà posé est retiré ; maisons, clôtures, remblai et jardins sont prioritaires
  const kept: Rect[] = [
    ...houses.map((h) => h.rect),
    ...fences,
    ...gardenBackfill,
    ...gardens.flatMap((g) => g.solids),
  ];
  const declutter = <T>(list: T[], rectOf: (item: T) => Rect): T[] =>
    list.filter((item) => {
      const r = rectOf(item);
      if (kept.some((o) => isNarrowGap(o, r, minGap))) return false;
      kept.push(r);
      return true;
    });
  lamps.splice(0, lamps.length, ...declutter(lamps, (p) => square(p, colliders.lampSize)));
  cars.splice(0, cars.length, ...declutter(cars, (c) => rectFromCenter(c, carSize)));
  trees.splice(0, trees.length, ...declutter(trees, (p) => square(p, colliders.trunkSize)));
  bins.splice(0, bins.length, ...declutter(bins, (p) => rectFromCenter(p, colliders.binSize)));
  crates.splice(0, crates.length, ...declutter(crates, (p) => square(p, colliders.crateSize)));
  const colliderRects: Rect[] = [
    ...houses.map((h) => h.rect),
    ...lamps.map((p) => square(p, colliders.lampSize)),
    ...trees.map((p) => square(p, colliders.trunkSize)),
    ...bins.map((p) => rectFromCenter(p, colliders.binSize)),
    ...crates.map((p) => square(p, colliders.crateSize)),
    ...cars.map((c) => rectFromCenter(c, carSize)),
    ...fences,
    ...gardenBackfill,
    ...gardens.flatMap((g) => g.solids),
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
    cellar,
    gardens,
    gardenBackfill,
    npcBlocked: gardens.flatMap((g) => [g.passage, g.garden]),
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

/**
 * Jardin caché derrière deux maisons voisines d'un côté (`side`) : passage entre elles, jardin
 * entre la ligne de fond (`backLine`, arrière des deux maisons) et `gardenDepth` plus loin,
 * clôturé sur trois côtés. Même géométrie pour le vrai jardin et les leurres ; le décor des
 * coins est tiré par la graine du jardin (`rng`).
 */
function hiddenGarden(
  f: QuartierFrame,
  side: -1 | 1,
  backLine: number,
  spans: { t0: number; t1: number }[],
  hc: QuartierParams['hiddenGardens'][number],
  colliders: QuartierColliders,
  rng: () => number,
): HiddenGardenLayout {
  const [a, b] = spans as [{ t0: number; t1: number }, { t0: number; t1: number }];
  const x = (d: number) => f.axisX + side * d;
  const box = sideBox(f, side);
  const th = colliders.fenceThickness;
  const outer = backLine + hc.gardenDepth;
  const garden = box(backLine, outer, a.t0, b.t1);
  const passage = box(f.sidewalkOuter, backLine, a.t1, b.t0);
  const fences = [
    box(backLine, outer + th, a.t0 - th, a.t0),
    box(backLine, outer + th, b.t1, b.t1 + th),
    box(outer, outer + th, a.t0, b.t1),
  ];
  const along = (k: number) => a.t0 + (b.t1 - a.t0) * k;
  const spot = {
    x: x(backLine + hc.gardenDepth * hc.spot.depth),
    z: alongZ(f, along(hc.spot.along)),
  };
  // coins du jardin (côté fond, côté maisons), mélangés par la graine : caisses, poubelle,
  // fauteuil ne sont jamais au même endroit d'un jardin à l'autre
  // coins : objets collés aux clôtures / aux arrières des maisons (aucune fente)
  const corners = [
    { d: outer, t: a.t0, dd: -1, dt: 1 },
    { d: outer, t: b.t1, dd: -1, dt: -1 },
    { d: backLine, t: a.t0, dd: 1, dt: 1 },
    { d: backLine, t: b.t1, dd: 1, dt: -1 },
  ];
  for (let i = corners.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [corners[i], corners[j]] = [corners[j]!, corners[i]!];
  }
  const [cA, cB, cC] = corners as [(typeof corners)[0], (typeof corners)[0], (typeof corners)[0]];
  // objet de taille (profondeur `sd`, longueur `st`) calé dans un coin
  const inCorner = (c: (typeof corners)[0], sd: number, st: number, shift = 0) => ({
    x: x(c.d + (c.dd * sd) / 2),
    z: alongZ(f, c.t + c.dt * (st / 2 + shift)),
  });
  const cs = colliders.crateSize;
  const crates = [inCorner(cA, cs, cs), inCorner(cA, cs, cs, cs)];
  const bins = [inCorner(cB, colliders.binSize.w, colliders.binSize.d)];
  const armchair = inCorner(cC, cs, cs);
  const real = hc.kind === 'real';
  const square = (p: Vec2, size: number) => rectFromCenter(p, { w: size, d: size });
  return {
    kind: hc.kind,
    side,
    passage,
    garden,
    spot,
    trapdoor: real ? spot : null,
    brokenChest: real ? null : spot,
    fences,
    fenceHeight: hc.fenceHeight,
    crates,
    bins,
    armchair,
    solids: [
      ...crates.map((p) => square(p, colliders.crateSize)),
      ...bins.map((p) => rectFromCenter(p, colliders.binSize)),
      square(armchair, colliders.crateSize),
      ...(real ? [] : [square(spot, colliders.crateSize)]),
    ],
    bulb: { ...spot },
  };
}

/** Rectangle entre deux distances à l'axe (côté `side`) et deux distances le long de la rue. */
function sideBox(f: QuartierFrame, side: -1 | 1) {
  return (d0: number, d1: number, t0: number, t1: number): Rect => {
    const [x0, x1] = [f.axisX + side * d0, f.axisX + side * d1];
    const [z0, z1] = [alongZ(f, t0), alongZ(f, t1)];
    return {
      minX: Math.min(x0, x1),
      maxX: Math.max(x0, x1),
      minZ: Math.min(z0, z1),
      maxZ: Math.max(z0, z1),
    };
  };
}

/**
 * Remblai plein d'un côté, de la ligne de fond au bord de l'area, partout sauf dans les jardins
 * (et leurs clôtures) : derrière les maisons, on n'atteint un jardin que par son passage.
 */
function backfillFor(
  f: QuartierFrame,
  side: -1 | 1,
  backLine: number,
  gardens: HiddenGardenLayout[],
  colliders: QuartierColliders,
  area: Bounds,
): Rect[] {
  if (gardens.length === 0) return [];
  const box = sideBox(f, side);
  const edge = side < 0 ? f.axisX - area.minX : area.maxX - f.axisX;
  const tEnd = Math.abs(f.dir < 0 ? f.entranceZ - area.minZ : area.maxZ - f.entranceZ);
  // étendue de chaque jardin le long de la rue (t) et vers le fond (d)
  const extents = gardens
    .map((g) => {
      const t = [g.garden.minZ, g.garden.maxZ].map((zz) => (zz - f.entranceZ) * f.dir);
      const d = [g.garden.minX, g.garden.maxX].map((xx) => (xx - f.axisX) * side);
      // collé au bord du jardin (il recouvre les clôtures) : ni fente avec les maisons, ni
      // avec le décor calé contre les clôtures
      return { t0: Math.min(...t), t1: Math.max(...t), outer: Math.max(...d) };
    })
    .sort((p, q) => p.t0 - q.t0);
  const out: Rect[] = [];
  let t = 0;
  for (const e of extents) {
    out.push(box(backLine, edge, t, e.t0));
    out.push(box(e.outer, edge, e.t0, e.t1));
    t = e.t1;
  }
  out.push(box(backLine, edge, t, tEnd));
  return out.filter((r) => r.maxX - r.minX > 1e-6 && r.maxZ - r.minZ > 1e-6);
}
