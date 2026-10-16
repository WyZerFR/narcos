import { describe, expect, it } from 'vitest';
import { areaAt } from './areas';
import { generateTowers, lotCars } from './cityBlocks';
import { isBlocked, obstaclesFrom } from './collision';
import { gameData } from './data';
import { expandRect, rectContainsRect, rectFromCenter, rectsOverlap } from './geometry';
import { footprint, interactionPoint, nearestLocation } from './locations';
import { cellIndex, createNavGrid, distancesFrom } from './navgrid';
import type { Block } from './schemas';
import { locationInteraction } from './zones';

const { config } = gameData;
const areas = [...gameData.areas.values()];
const obstacles = obstaclesFrom(gameData);
const radius = config.world.playerRadius;
const grid = createNavGrid(config.world.bounds, obstacles, radius, 0.5);
const fromSpawn = distancesFrom(grid, config.players.spawn);
const reachable = (p: { x: number; z: number }) => Number.isFinite(fromSpawn[cellIndex(grid, p)]);
const areaOf = (p: { x: number; z: number }) => areaAt(areas, p)?.id;
const LANDMARKS = gameData.blocks.filter((b) => b.style !== 'filler' && b.style !== 'tower');

describe('tours générées', () => {
  const lot: Block = {
    id: 'lot_test',
    position: { x: 10, z: -20 },
    size: { w: 31, d: 12 },
    height: 10,
    style: 'tower_lot',
  };
  const towers = generateTowers(lot, config.city.towers);

  it('pavent exactement l’îlot (mêmes collisions qu’avant), sans se chevaucher', () => {
    const area = towers.reduce((s, t) => s + t.size.w * t.size.d, 0);
    expect(area).toBeCloseTo(lot.size.w * lot.size.d, 6);
    for (const t of towers) expect(rectContainsRect(footprint(lot), footprint(t))).toBe(true);
    for (const [i, a] of towers.entries())
      for (const b of towers.slice(i + 1))
        expect(rectsOverlap(footprint(a), footprint(b))).toBe(false);
  });

  it('largeurs et hauteurs dans les bornes, même graine → mêmes tours', () => {
    const { minWidth, heights } = config.city.towers;
    for (const t of towers) {
      expect(Math.max(t.size.w, t.size.d)).toBeGreaterThanOrEqual(minWidth - 1e-9);
      expect(t.height).toBeGreaterThanOrEqual(heights[0]);
      expect(t.height).toBeLessThanOrEqual(heights[1]);
    }
    expect(generateTowers(lot, config.city.towers)).toEqual(towers);
  });

  it('les îlots du jeu sont découpés en tours, aucun îlot brut ne reste', () => {
    expect(gameData.blocks.some((b) => b.style === 'tower_lot')).toBe(false);
    expect(gameData.blocks.filter((b) => b.style === 'tower').length).toBeGreaterThan(10);
  });
});

describe('centre-ville et quartier commercial', () => {
  it('les façades attendues sont dans leur area', () => {
    const where = (style: string) =>
      LANDMARKS.filter((b) => b.style === style).map((b) => areaOf(b.position));
    expect(where('police')).toEqual(['centre_ville']);
    for (const s of ['dealership', 'gunshop', 'laundry', 'barber', 'kebab', 'parking'])
      expect(where(s), s).toEqual(['commercial']);
    expect(where('store').length).toBeGreaterThan(0);
    expect(
      gameData.blocks.filter((b) => areaOf(b.position) === 'centre_ville' && b.style === 'tower')
        .length,
    ).toBeGreaterThan(5);
  });

  it('banque et Bricoshop : seuls lieux interactifs, avec intérieur, atteignables', () => {
    const interactive = [...gameData.locations.values()]
      .filter((l) => ['centre_ville', 'commercial'].includes(areaOf(l.position) ?? ''))
      .filter((l) => locationInteraction(gameData, l) !== null)
      .map((l) => l.id)
      .sort();
    expect(interactive).toEqual(['banque', 'shop']);
    for (const id of interactive) {
      const loc = gameData.locations.get(id)!;
      expect(locationInteraction(gameData, loc)).toBe('enter');
      expect(reachable(interactionPoint(loc)), id).toBe(true);
    }
  });

  it('aucun lieu décoratif interactif : devant chaque façade, pas de bouton ACTION', () => {
    for (const b of LANDMARKS) {
      expect(gameData.locations.has(b.id)).toBe(false);
      const r = footprint(b);
      // juste devant la façade de l'enseigne
      const front = {
        north: { x: b.position.x, z: r.minZ - 1 },
        south: { x: b.position.x, z: r.maxZ + 1 },
        west: { x: r.minX - 1, z: b.position.z },
        east: { x: r.maxX + 1, z: b.position.z },
      }[b.door ?? 'south'];
      const near = nearestLocation(
        front,
        gameData.locations.values(),
        config.world.interactTolerance,
      );
      expect(near && locationInteraction(gameData, near), b.id).toBeFalsy();
    }
  });

  it('aucune tour ni façade ne chevauche une route ou un trottoir', () => {
    const streets = config.map.roads.map((r) =>
      expandRect(rectFromCenter(r, r), config.map.sidewalkWidth),
    );
    for (const b of gameData.blocks)
      expect(
        streets.some((s) => rectsOverlap(s, footprint(b))),
        b.id,
      ).toBe(false);
  });

  it('voitures rangées dans l’emprise de la concession et du parking, sans se chevaucher', () => {
    const { length, width } = config.decor.carSize;
    for (const b of LANDMARKS.filter((x) => x.style === 'dealership' || x.style === 'parking')) {
      const cars = lotCars(b, config.decor.carSize, config.city.lotCars);
      expect(cars.length, b.id).toBeGreaterThan(0);
      const rects = cars.map((c) =>
        rectFromCenter(c, c.rotY === 0 ? { w: length, d: width } : { w: width, d: length }),
      );
      for (const r of rects) expect(rectContainsRect(footprint(b), r), b.id).toBe(true);
      for (const [i, a] of rects.entries())
        for (const o of rects.slice(i + 1)) expect(rectsOverlap(a, o)).toBe(false);
    }
  });
});

describe('entrées d’areas', () => {
  it('chaque area marchable a un panneau d’entrée ou une arche de quartier', () => {
    const arches = new Set([...gameData.quartierLayouts.values()].map((l) => l.areaId));
    const gates = new Set(config.map.areaGates.map((g) => g.areaId));
    for (const a of areas.filter((x) => !x.locked))
      expect(gates.has(a.id) || arches.has(a.id), a.id).toBe(true);
  });

  it('les panneaux sont dégagés : point libre, atteignable, dans leur area', () => {
    for (const g of config.map.areaGates) {
      expect(isBlocked(g, radius, obstacles), g.areaId).toBe(false);
      expect(reachable(g), g.areaId).toBe(true);
      expect(areaOf(g)).toBe(g.areaId);
      // la largeur de route sous la traverse reste libre
      for (const t of [-2, -1, 1, 2]) {
        const p = g.axis === 'x' ? { x: g.x, z: g.z + t } : { x: g.x + t, z: g.z };
        expect(isBlocked(p, radius, obstacles), `${g.areaId} ${t}`).toBe(false);
      }
    }
  });
});
