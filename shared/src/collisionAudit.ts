import { airportLayout } from './airport';
import { areaAt, areaRects, walkableAreas } from './areas';
import { areaSpot } from './areaSpots';
import { findSlits, isBlocked, moveWithCollisions, obstaclesFrom } from './collision';
import type { GameData } from './data';
import { furnitureFixture, fixtureObstacles, fixtureRect, isSolidFixture } from './fixtures';
import { rectContainsPoint, rectFromCenter, type Rect, type Vec2 } from './geometry';
import { interactionPoint } from './locations';
import { freshBudget, validateMove, type MoveRules } from './movement';
import { cellIndex, createNavGrid, distancesFrom } from './navgrid';
import { generateLayout } from './placement';
import { interiorBounds, interiorForLocation, interiorObstacles, STREET } from './zones';
import type { Fixture } from './fixtures';

/**
 * Audit des collisions (pur, déterministe) : des milliers de déplacements aléatoires et dirigés
 * avec la fonction de collision partagée par le client (prédiction) et le serveur (validation).
 * Compte, par zone, les situations à problème. Sert au script `npm run collisions` (version
 * longue) et à un test Vitest (version courte, dans `npm run check`).
 */

export interface AuditZone {
  id: string;
  /** Zone de jeu (rue ou intérieur) pour les règles de déplacement. */
  zone: string;
  bounds: Rect;
  obstacles: Rect[];
  /** Où tirer les positions de départ. */
  regions: Rect[];
  /** Points où un joueur apparaît (entrée, sortie, reprise, téléportation). */
  entries: Vec2[];
  /** Meubles posés (labo) : on vérifie les 8 positions autour de chacun. */
  fixtures: Fixture[];
  /** Porte de sortie (intérieur) : doit rester atteignable. */
  door: Vec2 | null;
}

export interface AuditCounts {
  /** Positions libres d'où aucune des 8 directions ne fait avancer. */
  stuck: number;
  /** Mouvement en diagonale contre un mur qui perd la composante parallèle. */
  slideLoss: number;
  /** Trajet qui finit de l'autre côté d'un obstacle (traversé). */
  tunnel: number;
  /** Point d'apparition dans un obstacle. */
  entryBlocked: number;
  /** Correction serveur d'un mouvement légitime prédit par le client. */
  falseCorrection: number;
  /** Position finale de la validation serveur dans un obstacle. */
  insideAfterValidate: number;
  /** Passages plus étroits que le diamètre + marge (mais non nuls) entre deux obstacles. */
  narrowGaps: number;
  /** Position autour d'un meuble coincée ou coupée de la porte. */
  furnitureTrap: number;
  /** Tirages effectués. */
  samples: number;
}

export interface AuditOptions {
  samples: number;
  radius: number;
  walkSpeed: number;
  runSpeed: number;
  /** Pas d'une image (s). */
  dt: number;
  /** Envois client entre deux validations (images). */
  framesPerSend: number;
  toleranceFactor: number;
  maxBurstMs: number;
  /** Marge exigée au-delà du diamètre pour un passage. */
  gapMargin: number;
  /** Seuil de correction serveur (m) : un écart plus petit n'est pas corrigé. */
  correctionThreshold: number;
  seed: number;
}

const EIGHT = Array.from({ length: 8 }, (_, i) => ({
  x: Math.cos((i * Math.PI) / 4),
  z: Math.sin((i * Math.PI) / 4),
}));

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Murs (épais) autour de bornes : pour mesurer les écarts meuble ↔ mur. */
export function boundsWalls(b: Rect, t = 1): Rect[] {
  return [
    { minX: b.minX - t, maxX: b.maxX + t, minZ: b.minZ - t, maxZ: b.minZ },
    { minX: b.minX - t, maxX: b.maxX + t, minZ: b.maxZ, maxZ: b.maxZ + t },
    { minX: b.minX - t, maxX: b.minX, minZ: b.minZ, maxZ: b.maxZ },
    { minX: b.maxX, maxX: b.maxX + t, minZ: b.minZ, maxZ: b.maxZ },
  ];
}

/** Le segment [a, b] coupe-t-il l'intérieur strict du rectangle ? (test par échantillons fins) */
function segmentCrosses(a: Vec2, b: Vec2, r: Rect, step = 0.02): boolean {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step));
  const inner = {
    minX: r.minX + 1e-3,
    maxX: r.maxX - 1e-3,
    minZ: r.minZ + 1e-3,
    maxZ: r.maxZ - 1e-3,
  };
  if (inner.minX >= inner.maxX || inner.minZ >= inner.maxZ) return false;
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (rectContainsPoint(inner, { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }))
      return true;
  }
  return false;
}

/** Zones à auditer : areas marchables de l'île (quartiers en U compris), jardins cachés, intérieurs. */
export function auditZones(data: GameData): AuditZone[] {
  const street = obstaclesFrom(data);
  const world = data.config.world.bounds;
  // areas marchables (l'aéroport verrouillé est hors-zone)
  const areas = walkableAreas(data.areas.values());
  // départ, portes, panneaux d'entrée, points de téléportation de chaque area
  const streetEntries: Vec2[] = [
    data.config.players.spawn,
    ...[...data.locations.values()].map((l) => interactionPoint(l)),
    ...data.config.map.areaGates.map((g) => ({ x: g.x, z: g.z })),
    ...[...data.areas.keys()].flatMap((id) => areaSpot(data, id, street) ?? []),
  ];
  const gardens = [...data.quartierLayouts.values()].flatMap((l) => l.gardens);
  const zones: AuditZone[] = areas.map((a) => ({
    id: `area ${a.name}`,
    zone: STREET,
    bounds: world,
    obstacles: street,
    regions: areaRects(a),
    entries: streetEntries.filter((p) => areaAt([a], p) !== null),
    fixtures: [],
    door: null,
  }));
  zones.push({
    id: 'passages et jardins',
    zone: STREET,
    bounds: world,
    obstacles: street,
    regions: gardens.flatMap((g) => [g.passage, g.garden]),
    entries: gardens.map((g) => ({
      x: g.side < 0 ? g.garden.maxX - 0.75 : g.garden.minX + 0.75,
      z: (g.passage.minZ + g.passage.maxZ) / 2,
    })),
    fixtures: [],
    door: null,
  });
  // aéroport une fois déverrouillé (progression) : enceinte, portail, hangars, avions
  const airportArea = data.areas.get(data.config.airport.areaId);
  if (airportArea) {
    const areas = new Map(data.areas);
    areas.set(airportArea.id, { ...airportArea, locked: false });
    const open = { ...data, areas };
    const layout = airportLayout(data.config.airport, airportArea);
    const g = data.config.airport.gate;
    zones.push({
      id: 'aéroport déverrouillé',
      zone: STREET,
      bounds: world,
      obstacles: obstaclesFrom(open),
      regions: [layout.inner],
      entries: [g.axis === 'x' ? { x: g.x, z: g.z - 1.5 } : { x: g.x - 1.5, z: g.z }],
      fixtures: [],
      door: null,
    });
  }
  for (const interior of data.interiors.values()) {
    let fixtures: Fixture[] = [];
    if (interior.furnishable) {
      const kit = data.config.debug.equipKit;
      const wanted = [...data.items.values()]
        .filter((it) => it.placeable)
        .map((it) => ({ itemId: it.id, count: kit[it.placeable!.type] }));
      fixtures = generateLayout(data, { interior, fixtures: [], players: [] }, wanted).map((f, i) =>
        furnitureFixture({ id: `audit_${i}`, ...f }, data.items)!,
      );
    }
    const exit = interior.stations.find((s) => s.kind === 'exit');
    zones.push({
      id: `intérieur ${interior.id}`,
      zone: interior.id,
      bounds: interiorBounds(interior),
      obstacles: [...interiorObstacles(interior), ...fixtureObstacles(fixtures)],
      regions: [interiorBounds(interior)],
      entries: [interior.spawn],
      fixtures,
      door: exit ? { x: exit.position.x, z: exit.position.z - exit.size.d } : null,
    });
  }
  // sorties : le joueur réapparaît devant la porte du lieu d'entrée (rue)
  for (const interior of data.interiors.values()) {
    const loc = data.locations.get(interior.entranceLocationId);
    if (loc && interiorForLocation(data, loc.id)) zones[0]!.entries.push(interactionPoint(loc));
  }
  return zones;
}

/** Audite une zone : compte chaque type de problème sur `samples` tirages. */
export function auditZone(z: AuditZone, o: AuditOptions): AuditCounts {
  const rand = rng(o.seed);
  const r = o.radius;
  const c: AuditCounts = {
    stuck: 0,
    slideLoss: 0,
    tunnel: 0,
    entryBlocked: 0,
    falseCorrection: 0,
    insideAfterValidate: 0,
    narrowGaps: 0,
    furnitureTrap: 0,
    samples: 0,
  };
  const move = (from: Vec2, to: Vec2) => moveWithCollisions(from, to, r, z.obstacles, z.bounds);
  const rules: MoveRules = {
    maxSpeed: o.runSpeed,
    toleranceFactor: o.toleranceFactor,
    maxBurstMs: o.maxBurstMs,
    bounds: z.bounds,
    collision: { radius: r, obstacles: z.obstacles, correctionThreshold: o.correctionThreshold },
  };
  const area = z.regions.reduce((s, q) => s + (q.maxX - q.minX) * (q.maxZ - q.minZ), 0);
  const pick = (): Vec2 | null => {
    let t = rand() * area;
    for (const q of z.regions) {
      const a = (q.maxX - q.minX) * (q.maxZ - q.minZ);
      if (t > a) {
        t -= a;
        continue;
      }
      const p = { x: q.minX + rand() * (q.maxX - q.minX), z: q.minZ + rand() * (q.maxZ - q.minZ) };
      return isBlocked(p, r, z.obstacles) ? null : p;
    }
    return null;
  };
  const step = o.runSpeed * o.dt;
  const isStuck = (p: Vec2) =>
    EIGHT.every((d) => {
      const n = move(p, { x: p.x + d.x * step, z: p.z + d.z * step });
      return Math.hypot(n.x - p.x, n.z - p.z) < 0.01 * step;
    });

  for (let i = 0; i < o.samples; i++) {
    const p = pick();
    if (!p) continue;
    c.samples++;
    if (isStuck(p)) c.stuck++;
    // glissement : diagonale contre un mur → au moins la moitié de l'axe libre
    const d = EIGHT[1 + 2 * Math.floor(rand() * 4)]!;
    const want = { x: p.x + d.x * step, z: p.z + d.z * step };
    const got = move(p, want);
    const ax = move(p, { x: want.x, z: p.z });
    const az = move(p, { x: p.x, z: want.z });
    const moved = Math.hypot(got.x - p.x, got.z - p.z);
    const best = Math.max(Math.abs(ax.x - p.x), Math.abs(az.z - p.z));
    if (best > 0.2 * step && moved < 0.5 * best) c.slideLoss++;
    // course (images successives) puis rafale rejouée d'un coup : aucun pas ne traverse un obstacle
    const ang = rand() * Math.PI * 2;
    let prev = p;
    let crossed = false;
    for (let f = 0; f < 40 && !crossed; f++) {
      const next = move(prev, {
        x: prev.x + Math.cos(ang) * step,
        z: prev.z + Math.sin(ang) * step,
      });
      crossed = z.obstacles.some((ob) => segmentCrosses(prev, next, ob));
      prev = next;
    }
    const len = (o.runSpeed * o.toleranceFactor * o.maxBurstMs) / 1000;
    const far = move(p, { x: p.x + Math.cos(ang) * len, z: p.z + Math.sin(ang) * len });
    // rafale : l'arrivée doit rester du même côté que le trajet image par image
    if (crossed || isBlocked(far, r, z.obstacles)) c.tunnel++;
    // prédiction client (images) puis validation serveur du même trajet
    let client = p;
    for (let f = 0; f < o.framesPerSend; f++)
      client = move(client, {
        x: client.x + Math.cos(ang) * step,
        z: client.z + Math.sin(ang) * step,
      });
    const v = validateMove(p, client, freshBudget(0, rules), o.framesPerSend * o.dt * 1000, rules);
    if (v.corrected) c.falseCorrection++;
    if (isBlocked(v.pos, r, z.obstacles)) c.insideAfterValidate++;
  }
  for (const e of z.entries) if (isBlocked(e, r, z.obstacles)) c.entryBlocked++;
  // passages trop étroits entre obstacles voisins (dans les régions auditées)
  const inRegion = (ob: Rect) =>
    z.regions.some(
      (q) => ob.minX < q.maxX && ob.maxX > q.minX && ob.minZ < q.maxZ && ob.maxZ > q.minZ,
    );
  // les murs d'un intérieur comptent : un meuble à 0,3 m du mur forme une fente
  const walls = z.zone === STREET ? [] : boundsWalls(z.bounds);
  const local = [...z.obstacles.filter(inRegion), ...walls];
  c.narrowGaps = findSlits(local, 2 * r + o.gapMargin).length;
  // meubles : 8 positions autour de chacun, ni coincées ni coupées de la porte
  if (z.fixtures.length > 0 && z.door) {
    const grid = createNavGrid(z.bounds, z.obstacles, r, 0.1);
    const fromDoor = distancesFrom(grid, z.door);
    for (const f of z.fixtures.filter(isSolidFixture)) {
      const rect = fixtureRect(f);
      // un peu plus d'un rayon du meuble : au-delà de la case de grille qui touche le meuble
      const hw = (rect.maxX - rect.minX) / 2 + r + 0.15;
      const hd = (rect.maxZ - rect.minZ) / 2 + r + 0.15;
      for (const d of EIGHT) {
        const p = {
          x: f.position.x + Math.sign(Math.round(d.x * 10)) * hw,
          z: f.position.z + Math.sign(Math.round(d.z * 10)) * hd,
        };
        if (!rectContainsPoint(z.bounds, p) || isBlocked(p, r, z.obstacles)) continue;
        if (isStuck(p) || !Number.isFinite(fromDoor[cellIndex(grid, p)] ?? Infinity))
          c.furnitureTrap++;
      }
    }
  }
  return c;
}

/** Options de l'audit depuis config.json (collision, mouvement). */
export function auditOptions(data: GameData, samples: number, seed = 1): AuditOptions {
  const { movement, world, collision } = data.config;
  return {
    samples,
    radius: world.playerRadius,
    walkSpeed: movement.walkSpeed,
    runSpeed: movement.runSpeed,
    dt: 1 / 60,
    framesPerSend: Math.max(1, Math.round(60 / movement.clientSendRateHz)),
    toleranceFactor: movement.toleranceFactor,
    maxBurstMs: movement.maxBurstMs,
    gapMargin: collision.passageMargin,
    correctionThreshold: collision.correctionThreshold,
    seed,
  };
}

/** Rectangle utilitaire pour les tests (mur fin, etc.). */
export const wallRect = (x: number, z: number, w: number, d: number): Rect =>
  rectFromCenter({ x, z }, { w, d });
