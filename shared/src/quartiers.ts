import { footprint } from './locations';
import { areaAt, areaContainsRect } from './areas';
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
 * Quartiers générés (`quartiers.json`), en impasse ou en boucle en U : repère géométrique et,
 * plus bas, générateur déterministe des maisons et du décor. Pur : même entrée, même résultat
 * sur le client et le serveur.
 */

/**
 * Repère d'un quartier : il part du bord d'entrée de l'area (`street.opening`) et s'enfonce
 * selon `dir` (-1 = vers -Z, +1 = vers +Z). Les rues (`legs`) suivent des axes x constants :
 * une seule (impasse, x = `axisX`) ou deux de part et d'autre de l'îlot (U, entrée et sortie).
 * Les distances `t` se mesurent depuis l'entrée.
 */
export interface QuartierFrame {
  dir: 1 | -1;
  axisX: number;
  /** Axe x de chaque rue, d'ouest en est. */
  legs: number[];
  entranceZ: number;
  /** Demi-largeur chaussée + stationnement, puis bord extérieur du trottoir. */
  roadwayHalf: number;
  sidewalkOuter: number;
  /** Distance de l'axe d'une rue à l'arrière des maisons les plus profondes. */
  backLine: number;
  housesStart: number;
  housesEnd: number;
  /** Fin de la placette = façade du bâtiment du bout. */
  plazaEnd: number;
}

/** Repère du quartier dans son area (entrée sur le bord nord ou sud). */
export function quartierFrame(q: QuartierParams, area: Bounds): QuartierFrame {
  const s = q.street;
  const dir = s.opening === 'north' ? 1 : -1;
  const roadwayHalf = s.roadWidth / 2 + s.parkingWidth;
  const sidewalkOuter = roadwayHalf + s.sidewalkWidth;
  const backLine = sidewalkOuter + q.houses.setback[1] + q.houses.depth[1];
  // U : maisons de l'îlot dos à dos, de part et d'autre du remblai central
  const legOffset = backLine + s.islandCore / 2;
  const housesStart = s.entranceClear;
  const housesEnd = housesStart + s.housesLength;
  return {
    dir,
    axisX: s.axisX,
    legs: q.layout === 'u' ? [s.axisX - legOffset, s.axisX + legOffset] : [s.axisX],
    entranceZ: dir > 0 ? area.minZ : area.maxZ,
    roadwayHalf,
    sidewalkOuter,
    backLine,
    housesStart,
    housesEnd,
    plazaEnd: housesEnd + s.plazaDepth,
  };
}

/** Repère d'une des rues du quartier (même repère, axe déplacé). */
const legFrame = (f: QuartierFrame, leg: number): QuartierFrame => ({ ...f, axisX: f.legs[leg]! });

/** Rue d'un jardin caché : la plus à l'ouest pour `west`, la plus à l'est pour `east`. */
const gardenLeg = (f: QuartierFrame, side: 'west' | 'east') =>
  side === 'west' ? 0 : f.legs.length - 1;

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
  if (!area) return [`${where} : area "${q.areaId}" inconnue`];
  const f = quartierFrame(q, area.bounds);
  const errors: string[] = [];
  const h = q.houses;
  const spread = Math.max(...f.legs.map((x) => Math.abs(x - f.axisX)));
  if (!rectContainsRect(area.bounds, bandRect(f, 0, f.plazaEnd, spread + f.backLine)))
    errors.push(`${where} : les maisons débordent de l'area "${area.id}"`);
  if (!areaContainsRect(area, bandRect(f, 0, f.plazaEnd, spread + f.backLine)))
    errors.push(`${where} : le quartier sort du polygone de l'area "${area.id}"`);
  // entrée(s) : chaque rue débouche sur une autre area marchable
  for (const x of f.legs) {
    const outside = { x, z: f.entranceZ - f.dir * 0.5 };
    const next = areaAt(
      [...areas.values()].filter((a) => a.id !== area.id),
      outside,
    );
    if (!next || next.locked)
      errors.push(`${where} : la rue x = ${x} ne débouche sur aucune area marchable`);
  }
  if (q.layout === 'u' && q.street.plazaWidth / 2 < spread + f.sidewalkOuter)
    errors.push(`${where} : la place doit couvrir les deux rues du U (plazaWidth)`);
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
    const garden = f.backLine + hc.gardenDepth + 1;
    const legX = f.legs[gardenLeg(f, hc.side)]!;
    const edge = hc.side === 'west' ? legX - area.bounds.minX : area.bounds.maxX - legX;
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
  /** Rue (indice dans `frame.legs`) devant laquelle est la maison. */
  leg: number;
  /** -1 = côté ouest de l'axe de sa rue, +1 = côté est. */
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
  /**
   * Chaussées roulantes (toujours libres : une par rue, plus la traversée du fond en U),
   * bandes de stationnement, trottoirs, placette.
   */
  roads: Rect[];
  /** U : remblai plein au cœur de l'îlot (solide), sinon null. */
  islandCore: Rect | null;
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
  /** Rue (indice dans `frame.legs`) et côté du jardin. */
  leg: number;
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
  // (en U : jardins du côté extérieur de la rue ouest ou est)
  const sideOf = (g: { side: 'west' | 'east' }): -1 | 1 => (g.side === 'east' ? 1 : -1);
  const backLine = f.backLine;
  const inLeg = (g: { side: 'west' | 'east' }, leg: number) => gardenLeg(frame, g.side) === leg;
  const gardenOf = (leg: number, side: -1 | 1, k: number) =>
    q.hiddenGardens.findIndex(
      (g) => inLeg(g, leg) && sideOf(g) === side && (k === g.houseIndex || k === g.houseIndex + 1),
    );
  const spans = q.hiddenGardens.map(() => [] as { t0: number; t1: number }[]);
  const u = q.layout === 'u';

  for (let leg = 0; leg < frame.legs.length; leg++)
    for (const side of [-1, 1] as const) {
      const f = legFrame(frame, leg);
      // U : côté îlot (entre les deux rues), maisons dos à dos contre le remblai central
      const inner = u && (leg === 0 ? side > 0 : side < 0);
      const n = Math.round(between(rng, H.perSide));
      const slot = s.housesLength / n;
      // lampadaires contre la bordure (le trottoir reste libre côté jardinets)
      const lampX = f.axisX + side * (f.roadwayHalf + colliders.lampSize / 2);
      // ligne de fond de ce côté : remblai (côté à jardins, îlot du U) ou bord de l'area
      const hasGardens = q.hiddenGardens.some((g) => inLeg(g, leg) && sideOf(g) === side);
      const wallLine =
        hasGardens || inner ? backLine : side < 0 ? f.axisX - area.minX : area.maxX - f.axisX;
      let lastLamp = -Infinity;
      const addLamp = (t: number) => {
        if (t - lastLamp < D.streetlightSpacing) return;
        lamps.push({ x: lampX, z: z(t) });
        lastLamp = t;
      };
      addLamp(f.housesStart + colliders.lampSize);
      for (let k = 0; k < n; k++) {
        const gi = gardenOf(leg, side, k);
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
          for (
            let u = -w / 2 + WINDOW_MARGIN;
            u <= w / 2 - WINDOW_MARGIN + 1e-6;
            u += WINDOW_STEP
          ) {
            if (floor === 0 && Math.abs(u - doorU) < DOOR_W) continue;
            if (floor === 0 && garageU !== null && Math.abs(u - garageU) < GARAGE_W / 2 + 0.6)
              continue;
            windows.push({ u, floor, lit: rng() < H.windowLitChance });
          }
        houses.push({
          id: `${q.id}_${u ? `r${leg + 1}` : ''}${side < 0 ? 'o' : 'e'}${k + 1}`,
          leg,
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
            gardenLeg(f, g.side),
            legFrame(f, gardenLeg(f, g.side)),
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
  const gardenBackfill = f.legs.flatMap((_, leg) =>
    ([-1, 1] as const).flatMap((side) =>
      backfillFor(
        legFrame(f, leg),
        side,
        backLine,
        gardens.filter((g) => g.side === side && g.leg === leg),
        colliders,
        area,
      ),
    ),
  );
  // U : remblai plein au cœur de l'îlot, entre les arrières des maisons des deux rues
  const islandCore =
    u && s.islandCore > 0 ? bandRect(f, f.housesStart, f.housesEnd, s.islandCore / 2) : null;
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
    for (const x of f.legs)
      for (let t = f.housesStart; t <= f.housesEnd; t += D.garlandSpacing)
        garlands.push({
          a: { x: x - f.sidewalkOuter, z: z(t) },
          b: { x: x + f.sidewalkOuter, z: z(t) },
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
  // arche au-dessus de la première rue (l'entrée du U)
  const archZ = z(s.entranceClear / 2);
  const archX = f.legs[0]!;
  const arch = {
    left: { x: archX - f.sidewalkOuter - 0.5, z: archZ },
    right: { x: archX + f.sidewalkOuter + 0.5, z: archZ },
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
    ...(islandCore ? [islandCore] : []),
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
    ...(islandCore ? [islandCore] : []),
  ];
  // bandes symétriques de part et d'autre de l'axe de chaque rue, entre deux demi-largeurs
  const strips = (inner: number, outer: number): Rect[] =>
    f.legs.flatMap((x, leg) => {
      const r = bandRect(legFrame(f, leg), 0, f.housesEnd, outer);
      return [
        { ...r, maxX: x - inner },
        { ...r, minX: x + inner },
      ];
    });
  const sidewalks = strips(f.roadwayHalf, f.sidewalkOuter);
  const parking = strips(s.roadWidth / 2, f.roadwayHalf);
  const roads = f.legs.map((_, leg) => bandRect(legFrame(f, leg), 0, f.housesEnd, s.roadWidth / 2));
  // U : traversée au fond, d'une rue à l'autre, devant la place
  if (u) {
    const cross = bandRect(f, f.housesEnd, f.housesEnd + s.roadWidth, 0);
    roads.push({
      ...cross,
      minX: f.legs[0]! - s.roadWidth / 2,
      maxX: f.legs[f.legs.length - 1]! + s.roadWidth / 2,
    });
  }
  return {
    id: q.id,
    areaId: q.areaId,
    frame: f,
    roads,
    islandCore,
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

/** Points de passage des PNJ : de part et d'autre de l'axe de chaque chaussée, puis la placette. */
function npcWaypoints(f: QuartierFrame, s: QuartierParams['street']): Vec2[] {
  const out: Vec2[] = [];
  const lane = s.roadWidth / 4;
  for (const x of f.legs)
    for (let t = s.npcWaypointSpacing / 2; t < f.housesEnd; t += s.npcWaypointSpacing)
      for (const side of [-1, 1]) out.push({ x: x + side * lane, z: alongZ(f, t) });
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
  leg: number,
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
    leg,
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
