import { describe, expect, it } from 'vitest';
import { gameData } from './data';
import { isBlocked, moveWithCollisions, obstaclesFrom } from './collision';
import { rectContainsPoint, rectsOverlap, type Rect } from './geometry';
import { interactionPoint } from './locations';
import { cellIndex, createNavGrid, distancesFrom } from './navgrid';
import { bandRect, generateQuartier, quartierFrame, seededRng } from './quartiers';

const { config } = gameData;
const layouts = [...gameData.quartierLayouts.values()];
const paramsOf = (id: string) => gameData.quartiers.get(id)!;
const obstacles = obstaclesFrom(gameData);
const radius = config.world.playerRadius;
const grid = createNavGrid(config.world.bounds, obstacles, radius, 0.5);
const fromSpawn = distancesFrom(grid, config.players.spawn);
const areaOf = (l: { areaId: string }) => gameData.areas.get(l.areaId)!.bounds;
const MIN_GAP = 2 * config.world.playerRadius + config.collision.passageMargin;
/** Rangées de maisons : une par rue et par côté (4 dans un U). */
const rows = (l: (typeof layouts)[number]) =>
  l.frame.legs.flatMap((_, leg) =>
    ([-1, 1] as const).map((side) => l.houses.filter((h) => h.leg === leg && h.side === side)),
  );
/** Plus petite dimension d'une chaussée (largeur d'une rue ou de la traversée). */
const roadWidth = (r: Rect) => Math.min(r.maxX - r.minX, r.maxZ - r.minZ);

describe('génération des quartiers en U', () => {
  it('deux boucles en U : El Jefe (cartel) et chez nous', () => {
    expect(layouts.map((l) => [l.id, l.areaId])).toEqual([
      ['nord', 'cartel'],
      ['sud', 'chez_nous'],
    ]);
    for (const l of layouts) {
      expect(paramsOf(l.id).layout).toBe('u');
      expect(l.frame.legs).toHaveLength(2);
      // deux rues + la traversée du fond, remblai au cœur de l'îlot
      expect(l.roads).toHaveLength(3);
      expect(l.islandCore).not.toBeNull();
    }
  });

  it('une seule fonction pour les deux modes : la même graine en impasse donne une seule rue', () => {
    const l = layouts.find((x) => x.id === 'sud')!;
    const q = { ...paramsOf('sud'), layout: 'dead_end' as const, hiddenGardens: [] };
    const area = areaOf(l);
    const dead = generateQuartier(
      q,
      quartierFrame(q, area),
      gameData.quartierColliders,
      config.decor.carSize,
      area,
      MIN_GAP,
    );
    expect(dead.frame.legs).toEqual([q.street.axisX]);
    expect(dead.roads).toHaveLength(1);
    expect(dead.islandCore).toBeNull();
    for (const [i, h] of dead.houses.entries()) {
      for (const o of dead.houses.slice(i + 1)) expect(rectsOverlap(h.rect, o.rect)).toBe(false);
      for (const r of [...dead.roads, ...dead.sidewalks])
        expect(rectsOverlap(h.rect, r)).toBe(false);
    }
  });

  it('déterministe : même graine, même résultat ; autre graine, autre résultat', () => {
    for (const l of layouts) {
      const q = paramsOf(l.id);
      const again = generateQuartier(
        q,
        l.frame,
        gameData.quartierColliders,
        config.decor.carSize,
        areaOf(l),
        MIN_GAP,
      );
      expect(again).toEqual(l);
      const other = generateQuartier(
        { ...q, seed: `${q.seed}-autre` },
        l.frame,
        gameData.quartierColliders,
        config.decor.carSize,
        areaOf(l),
        MIN_GAP,
      );
      expect(other).not.toEqual(l);
    }
    const a = seededRng('x');
    const b = seededRng('x');
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('maisons de chaque côté de chaque rue (extérieur et îlot), dans la fourchette du JSON', () => {
    for (const l of layouts) {
      const [min, max] = paramsOf(l.id).houses.perSide;
      expect(rows(l)).toHaveLength(4);
      for (const row of rows(l)) {
        expect(row.length).toBeGreaterThanOrEqual(min);
        expect(row.length).toBeLessThanOrEqual(max);
      }
    }
  });

  it('aucune maison n’en chevauche une autre ni la rue, le trottoir ou la placette', () => {
    for (const l of layouts)
      for (const [i, h] of l.houses.entries()) {
        for (const o of l.houses.slice(i + 1)) expect(rectsOverlap(h.rect, o.rect)).toBe(false);
        for (const r of [...l.roads, l.plaza, ...l.parking, ...l.sidewalks])
          expect(rectsOverlap(h.rect, r), h.id).toBe(false);
      }
  });

  it('chaussée en boucle d’au moins 6 m, libre de tout obstacle sur toute la longueur', () => {
    for (const l of layouts)
      for (const road of l.roads) {
        expect(roadWidth(road)).toBeGreaterThanOrEqual(6);
        expect(obstacles.some((o) => rectsOverlap(o, road))).toBe(false);
      }
  });

  it('entrée et sortie du U libres (chaussée et trottoirs)', () => {
    for (const l of layouts)
      for (const x of l.frame.legs) {
        const f = { ...l.frame, axisX: x };
        const entrance = bandRect(f, 0, f.housesStart, f.sidewalkOuter);
        expect(
          obstacles.some((o) => rectsOverlap(o, entrance)),
          `${l.id} x = ${x}`,
        ).toBe(false);
      }
  });

  it('placette dégagée devant El Jefe au nord et devant Le Local au sud', () => {
    for (const l of layouts) {
      expect(
        obstacles.some((o) => rectsOverlap(o, l.plaza)),
        l.id,
      ).toBe(false);
      const loc = gameData.locations.get(paramsOf(l.id).landmarkLocationId)!;
      expect(rectContainsPoint(l.plaza, interactionPoint(loc))).toBe(true);
    }
    expect(paramsOf('nord').landmarkLocationId).toBe('repaire_jefe');
    expect(paramsOf('sud').landmarkLocationId).toBe('local');
  });

  it('porte de chaque maison atteignable depuis le trottoir et depuis le départ', () => {
    for (const l of layouts)
      for (const h of l.houses) {
        expect(isBlocked(h.doorStep, radius, obstacles), h.id).toBe(false);
        // juste devant la porte (sur le jardinet), le joueur tient debout
        const front = { x: h.frontX - h.side * (radius + 0.05), z: h.door.z };
        expect(isBlocked(front, radius, obstacles), `${h.id} porte`).toBe(false);
        // grille de 0,5 m : cases à 1 m de la façade (jardinet d'au moins 1,2 m), sur la largeur
        // de la porte (une poubelle peut la jouxter, sa marge déborde sur une case)
        const yard = [-0.5, 0, 0.5].map((dz) => ({ x: h.frontX - h.side * 1, z: h.door.z + dz }));
        expect(
          yard.some((p) => Number.isFinite(fromSpawn[cellIndex(grid, p)]!)),
          h.id,
        ).toBe(true);
        expect(Number.isFinite(fromSpawn[cellIndex(grid, h.doorStep)]!), h.id).toBe(true);
      }
  });

  it('collisions : on ne traverse ni maison, ni lampadaire, ni arbre', () => {
    const bounds = config.world.bounds;
    for (const l of layouts) {
      const h = l.houses[0]!;
      const zc = (h.rect.minZ + h.rect.maxZ) / 2;
      const start = { x: h.frontX - h.side * 1, z: zc };
      const target = { x: h.frontX + h.side * 3, z: zc };
      const end = moveWithCollisions(start, target, radius, obstacles, bounds);
      expect(rectContainsPoint(h.rect, end)).toBe(false);
      expect(Math.abs(end.x - h.frontX)).toBeGreaterThanOrEqual(radius - 1e-6);
      for (const p of [l.lamps[0]!, l.trees[0]!]) {
        const from = { x: p.x, z: p.z - 3 };
        const to = { x: p.x, z: p.z + 3 };
        const stop = moveWithCollisions(from, to, radius, obstacles, bounds);
        expect(stop.z).toBeLessThan(p.z);
      }
    }
  });

  it('bâtiment du bout : gardes au nord, guirlandes au sud, arche à l’entrée', () => {
    const nord = layouts.find((l) => l.id === 'nord')!;
    const sud = layouts.find((l) => l.id === 'sud')!;
    expect(nord.guards).toHaveLength(2);
    expect(nord.gate).not.toBeNull();
    expect(sud.garlands.length).toBeGreaterThan(0);
    for (const g of nord.guards) expect(rectContainsPoint(nord.plaza, g)).toBe(true);
    expect(nord.arch.label).toMatch(/EL JEFE/);
    expect(sud.arch.label).toMatch(/CHEZ NOUS/);
  });
});

describe('accès aux quartiers en U depuis les avenues', () => {
  it('chemin sur la grille : départ → chaque entrée du U → place du fond', () => {
    for (const l of layouts)
      for (const x of l.frame.legs) {
        const f = { ...l.frame, axisX: x };
        const entrance = { x, z: f.entranceZ + f.dir * 1 };
        const plaza = {
          x: (l.plaza.minX + l.plaza.maxX) / 2,
          z: (l.plaza.minZ + l.plaza.maxZ) / 2,
        };
        expect(Number.isFinite(fromSpawn[cellIndex(grid, entrance)]!), `${l.id} entrée`).toBe(true);
        const fromEntrance = distancesFrom(grid, entrance);
        expect(Number.isFinite(fromEntrance[cellIndex(grid, plaza)]!), `${l.id} place`).toBe(true);
        // aucun obstacle (immeuble, décor, hors-zone) sur toute la largeur rue + trottoirs
        const mouth = bandRect(f, -1, f.housesStart, f.sidewalkOuter);
        expect(
          obstacles.some((o) => rectsOverlap(o, mouth)),
          `${l.id} x = ${x}`,
        ).toBe(false);
      }
  });

  it('boucle : de l’entrée à la sortie par la traversée du fond, sans passer par l’avenue', () => {
    for (const l of layouts) {
      const area = gameData.areas.get(l.areaId)!;
      // grille bornée à l'area, bout de l'îlot fermé : le seul chemin passe par la traversée
      const f = l.frame;
      const half = Math.max(...f.legs.map((x) => Math.abs(x - f.axisX))) + f.backLine;
      const tip = bandRect(f, -1, f.housesStart, half);
      const local = createNavGrid(area.bounds, [...obstacles, tip], radius, 0.5);
      const t = f.housesStart + 2;
      const [a, b] = f.legs.map((x) => ({ x, z: f.entranceZ + f.dir * t }));
      const m = distancesFrom(local, a!)[cellIndex(local, b!)]!;
      expect(Number.isFinite(m), l.id).toBe(true);
      expect(m).toBeGreaterThan(2 * (f.housesEnd - t));
    }
  });
});

describe('jardins cachés de chez nous : la vraie cachette et ses leurres', () => {
  const sud = layouts.find((l) => l.id === 'sud')!;
  const params = paramsOf('sud');
  const c = sud.cellar!;
  const trapdoor = c.trapdoor!;
  const center = (r: Rect) => ({ x: (r.minX + r.maxX) / 2, z: (r.minZ + r.maxZ) / 2 });

  it('trois jardins : un vrai (trappe = trappe_cave, caché), deux leurres sans trappe', () => {
    expect(layouts.find((l) => l.id === 'nord')!.gardens).toEqual([]);
    expect(sud.gardens.map((g) => g.kind).sort()).toEqual(['decoy', 'decoy', 'real']);
    expect(sud.gardens.filter((g) => g.trapdoor !== null)).toEqual([c]);
    for (const g of sud.gardens.filter((x) => x.kind === 'decoy'))
      expect(g.brokenChest).not.toBeNull();
    const trap = gameData.locations.get(params.cellarLocationId!)!;
    expect(trap.hidden).toBe(true);
    expect(trap.interactRadius).toBe(1.5);
    expect(rectContainsPoint(c.garden, trapdoor)).toBe(true);
    expect(Math.hypot(trap.position.x - trapdoor.x, trap.position.z - trapdoor.z)).toBeLessThan(
      0.05,
    );
  });

  it('leurres : opposé à la vraie, et du même côté à au moins 2 maisons d’écart', () => {
    const real = params.hiddenGardens.find((g) => g.kind === 'real')!;
    const decoys = params.hiddenGardens.filter((g) => g.kind === 'decoy');
    expect(decoys.some((d) => d.side !== real.side)).toBe(true);
    const same = decoys.find((d) => d.side === real.side)!;
    // maisons utilisées : i, i+1 ; écart = maisons strictement entre les deux paires
    const between = Math.abs(same.houseIndex - real.houseIndex) - 2;
    expect(between).toBeGreaterThanOrEqual(2);
  });

  it('passages d’au moins la largeur configurée, libres, entre deux maisons voisines', () => {
    for (const [i, g] of sud.gardens.entries()) {
      const p = params.hiddenGardens[i]!;
      expect(g.passage.maxZ - g.passage.minZ).toBeGreaterThanOrEqual(p.passageWidth - 1e-9);
      expect(obstacles.some((o) => rectsOverlap(o, g.passage))).toBe(false);
      const neighbours = sud.houses.filter(
        (h) =>
          h.leg === g.leg &&
          h.side === g.side &&
          (h.rect.maxZ === g.passage.minZ || h.rect.minZ === g.passage.maxZ),
      );
      expect(neighbours).toHaveLength(2);
    }
  });

  it('aucun chevauchement entre jardins, ni avec les maisons ; accès uniquement par le passage', () => {
    for (const [i, g] of sud.gardens.entries()) {
      for (const h of sud.houses) expect(rectsOverlap(h.rect, g.garden), h.id).toBe(false);
      for (const o of sud.gardens.slice(i + 1))
        expect(rectsOverlap(g.garden, o.garden)).toBe(false);
      const plugged = createNavGrid(config.world.bounds, [...obstacles, g.passage], radius, 0.5);
      const d = distancesFrom(plugged, config.players.spawn)[cellIndex(plugged, g.spot)]!;
      expect(d, `jardin ${i}`).toBe(Infinity);
    }
  });

  it('les 3 jardins, leurs passages et la trappe sont atteignables à pied depuis le départ', () => {
    for (const g of sud.gardens) {
      const free = { x: (g.passage.minX + g.passage.maxX) / 2, z: center(g.passage).z };
      // entrée du jardin, au débouché du passage (le centre peut porter le coffre d'un leurre)
      const inside = {
        x: g.side < 0 ? g.garden.maxX - 0.75 : g.garden.minX + 0.75,
        z: center(g.passage).z,
      };
      for (const p of [free, inside])
        expect(Number.isFinite(fromSpawn[cellIndex(grid, p)]!), JSON.stringify(p)).toBe(true);
    }
    expect(Number.isFinite(fromSpawn[cellIndex(grid, trapdoor)]!)).toBe(true);
    expect(isBlocked(trapdoor, radius, obstacles)).toBe(false);
  });

  it('les leurres n’ont aucun lieu interactif ; trappe_cave est le seul lieu caché', () => {
    const hidden = [...gameData.locations.values()].filter((l) => l.hidden);
    expect(hidden.map((l) => l.id)).toEqual(['trappe_cave']);
    for (const g of sud.gardens.filter((x) => x.kind === 'decoy'))
      for (const loc of gameData.locations.values())
        expect(rectContainsPoint(g.garden, loc.position), loc.id).toBe(false);
  });

  it('décor varié d’un jardin à l’autre (graine) et déterministe', () => {
    const corners = sud.gardens.map((g) =>
      [g.armchair, ...g.bins].map((p) => [
        Math.round(p.x - g.garden.minX),
        Math.round(p.z - g.garden.minZ),
      ]),
    );
    expect(new Set(corners.map((x) => JSON.stringify(x))).size).toBeGreaterThan(1);
  });

  it('chaussée ≥ 6 m, placette devant Le Local dégagée, maisons dans la fourchette', () => {
    for (const road of sud.roads) expect(roadWidth(road)).toBeGreaterThanOrEqual(6);
    expect(obstacles.some((o) => rectsOverlap(o, sud.plaza))).toBe(false);
    const [min, max] = params.houses.perSide;
    for (const row of rows(sud)) {
      expect(row.length).toBeGreaterThanOrEqual(min);
      expect(row.length).toBeLessThanOrEqual(max);
    }
  });

  it('PNJ exclus : tous les passages et jardins dans npcBlocked', () => {
    expect(sud.npcBlocked).toEqual(sud.gardens.flatMap((g) => [g.passage, g.garden]));
  });
});
