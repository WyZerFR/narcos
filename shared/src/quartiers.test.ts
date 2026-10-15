import { describe, expect, it } from 'vitest';
import { gameData } from './data';
import { isBlocked, moveWithCollisions, obstaclesFrom } from './collision';
import { rectContainsPoint, rectsOverlap, type Rect } from './geometry';
import { interactionPoint } from './locations';
import { cellIndex, createNavGrid, distancesFrom } from './navgrid';
import { bandRect, generateQuartier, seededRng } from './quartiers';

const { config } = gameData;
const layouts = [...gameData.quartierLayouts.values()];
const paramsOf = (id: string) => gameData.quartiers.get(id)!;
const obstacles = obstaclesFrom(gameData);
const radius = config.world.playerRadius;
const grid = createNavGrid(config.world.bounds, obstacles, radius, 0.5);
const fromSpawn = distancesFrom(grid, config.players.spawn);
const width = (r: Rect) => r.maxX - r.minX;

describe('génération des impasses', () => {
  it('deux impasses générées : nord et sud', () => {
    expect(layouts.map((l) => [l.id, l.areaId])).toEqual([
      ['nord', 'north'],
      ['sud', 'south'],
    ]);
  });

  it('déterministe : même graine, même résultat ; autre graine, autre résultat', () => {
    for (const l of layouts) {
      const q = paramsOf(l.id);
      const again = generateQuartier(q, l.frame, gameData.quartierColliders, config.decor.carSize);
      expect(again).toEqual(l);
      const other = generateQuartier(
        { ...q, seed: `${q.seed}-autre` },
        l.frame,
        gameData.quartierColliders,
        config.decor.carSize,
      );
      expect(other).not.toEqual(l);
    }
    const a = seededRng('x');
    const b = seededRng('x');
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('nombre de maisons par côté dans la fourchette du JSON', () => {
    for (const l of layouts) {
      const [min, max] = paramsOf(l.id).houses.perSide;
      for (const side of [-1, 1]) {
        const n = l.houses.filter((h) => h.side === side).length;
        expect(n).toBeGreaterThanOrEqual(min);
        expect(n).toBeLessThanOrEqual(max);
      }
    }
  });

  it('aucune maison n’en chevauche une autre ni la rue, le trottoir ou la placette', () => {
    for (const l of layouts)
      for (const [i, h] of l.houses.entries()) {
        for (const o of l.houses.slice(i + 1)) expect(rectsOverlap(h.rect, o.rect)).toBe(false);
        for (const r of [l.road, l.plaza, ...l.parking, ...l.sidewalks])
          expect(rectsOverlap(h.rect, r), h.id).toBe(false);
      }
  });

  it('chaussée d’au moins 6 m, libre de tout obstacle sur toute la longueur', () => {
    for (const l of layouts) {
      expect(width(l.road)).toBeGreaterThanOrEqual(6);
      expect(obstacles.some((o) => rectsOverlap(o, l.road))).toBe(false);
    }
  });

  it('entrée de l’impasse libre (chaussée et trottoirs)', () => {
    for (const l of layouts) {
      const f = l.frame;
      const entrance = bandRect(f, 0, f.housesStart, f.sidewalkOuter);
      expect(
        obstacles.some((o) => rectsOverlap(o, entrance)),
        l.id,
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
        // grille de 0,5 m : on teste la case à 1 m de la façade (jardinet d'au moins 1,2 m)
        const yard = { x: h.frontX - h.side * 1, z: h.door.z };
        expect(Number.isFinite(fromSpawn[cellIndex(grid, yard)]!), h.id).toBe(true);
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
    expect(nord.arch.label).toMatch(/QUARTIER NORD/);
    expect(sud.arch.label).toMatch(/QUARTIER SUD/);
  });
});

describe('accès aux impasses depuis la rue centrale', () => {
  it('chemin sur la grille : départ → entrée de l’impasse → placette du fond', () => {
    for (const l of layouts) {
      const f = l.frame;
      const entrance = { x: f.axisX, z: f.entranceZ + f.dir * 1 };
      const plaza = {
        x: (l.plaza.minX + l.plaza.maxX) / 2,
        z: (l.plaza.minZ + l.plaza.maxZ) / 2,
      };
      expect(Number.isFinite(fromSpawn[cellIndex(grid, entrance)]!), `${l.id} entrée`).toBe(true);
      const fromEntrance = distancesFrom(grid, entrance);
      expect(Number.isFinite(fromEntrance[cellIndex(grid, plaza)]!), `${l.id} placette`).toBe(true);
      // aucun obstacle (immeuble, décor, hors-zone) sur toute la largeur rue + trottoirs à l'entrée
      const mouth = bandRect(f, -1, f.housesStart, f.sidewalkOuter);
      expect(
        obstacles.some((o) => rectsOverlap(o, mouth)),
        l.id,
      ).toBe(false);
    }
  });
});
