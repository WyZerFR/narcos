import { describe, expect, it } from 'vitest';
import { areaAt, areaRects, walkableAreas } from './areas';
import { isBlocked, moveWithCollisions, obstaclesFrom } from './collision';
import { gameData } from './data';
import { expandRect, rectContainsPoint, rectsOverlap, type Vec2 } from './geometry';
import { coastline, islandLayout } from './island';
import { cellCenter, cellIndex, createNavGrid, distancesFrom } from './navgrid';

const { config } = gameData;
const areas = [...gameData.areas.values()];
const walkable = walkableAreas(areas);
const obstacles = obstaclesFrom(gameData);
const radius = config.world.playerRadius;
const world = config.world.bounds;
const grid = createNavGrid(world, obstacles, radius, 0.5);
const fromSpawn = distancesFrom(grid, config.players.spawn);
const { coast, beaches, palms } = gameData.island;

/**
 * Points le long de chaque bord, à `d` m de la côte vers l'intérieur, tous les `step` m, à 1 m
 * au moins des extrémités (dans un coin, deux côtes se rapprochent).
 */
function inland(step: number, d: number): { p: Vec2; out: Vec2 }[] {
  const out: { p: Vec2; out: Vec2 }[] = [];
  for (const e of coast) {
    const len = Math.hypot(e.b.x - e.a.x, e.b.z - e.a.z);
    for (let t = 1; t < len - 1; t += step) {
      const u = t / len;
      const x = e.a.x + (e.b.x - e.a.x) * u;
      const z = e.a.z + (e.b.z - e.a.z) * u;
      out.push({ p: { x: x - e.nx * d, z: z - e.nz * d }, out: { x: e.nx, z: e.nz } });
    }
  }
  return out;
}

describe('côte de l’île', () => {
  it('contour fermé : terre d’un côté, mer de l’autre, chaque sommet partagé par deux bords', () => {
    expect(coast.length).toBeGreaterThan(8);
    for (const e of coast) {
      const mid = { x: (e.a.x + e.b.x) / 2, z: (e.a.z + e.b.z) / 2 };
      expect(areaAt(areas, { x: mid.x - e.nx * 0.01, z: mid.z - e.nz * 0.01 })).not.toBeNull();
      expect(areaAt(areas, { x: mid.x + e.nx * 0.01, z: mid.z + e.nz * 0.01 })).toBeNull();
    }
    const ends = new Map<string, number>();
    for (const e of coast)
      for (const p of [e.a, e.b]) ends.set(`${p.x},${p.z}`, (ends.get(`${p.x},${p.z}`) ?? 0) + 1);
    for (const [k, n] of ends) expect(n, k).toBe(2);
  });

  it('déterministe : même graine, même île', () => {
    expect(islandLayout(areas, config.island)).toEqual(gameData.island);
    expect(coastline(areas)).toEqual(coast);
  });

  it('aucun point marchable hors de l’île (mer, côte, aéroport verrouillé)', () => {
    for (let x = world.minX + 0.5; x < world.maxX; x += 2)
      for (let z = world.minZ + 0.5; z < world.maxZ; z += 2) {
        const p = { x, z };
        if (areaAt(walkable, p) === null)
          expect(isBlocked(p, radius, obstacles), `${x},${z}`).toBe(true);
      }
    // et aucune case accessible depuis le départ n'est en mer
    fromSpawn.forEach((d, i) => {
      if (Number.isFinite(d)) expect(areaAt(walkable, cellCenter(grid, i))).not.toBeNull();
    });
  });

  it('joueur arrêté par la côte : 10 m vers la mer, il reste sur l’île, à un rayon du bord', () => {
    let tested = 0;
    for (const { p, out } of inland(6, radius + 0.3)) {
      if (areaAt(walkable, p) === null || isBlocked(p, radius, obstacles)) continue;
      const end = moveWithCollisions(
        p,
        { x: p.x + out.x * 10, z: p.z + out.z * 10 },
        radius,
        obstacles,
        world,
      );
      expect(areaAt(walkable, end), JSON.stringify(p)).not.toBeNull();
      const pushed = (end.x - p.x) * out.x + (end.z - p.z) * out.z;
      expect(pushed).toBeLessThanOrEqual(0.3 + 1e-6);
      tested++;
    }
    expect(tested).toBeGreaterThan(40);
  });

  it('aucun joueur coincé le long de la côte : chaque point libre au bord rejoint le départ', () => {
    let tested = 0;
    for (const { p, out } of inland(3, radius + 0.3)) {
      if (areaAt(walkable, p) === null || isBlocked(p, radius, obstacles)) continue;
      // case de la grille (0,5 m) du point, ou un demi-pas vers l'intérieur (obstacle voisin)
      const reached = [0, 0.5].some((k) => {
        const q = { x: p.x - out.x * k, z: p.z - out.z * k };
        return Number.isFinite(fromSpawn[cellIndex(grid, q)]!);
      });
      expect(reached, JSON.stringify(p)).toBe(true);
      tested++;
    }
    expect(tested).toBeGreaterThan(80);
  });

  it('plages et palmiers : sur le sable, jamais sur l’île ni sur l’eau', () => {
    expect(beaches.length).toBeGreaterThan(2);
    expect(palms.length).toBeGreaterThan(10);
    const land = areas.flatMap(areaRects);
    for (const b of beaches)
      for (const r of land) expect(rectsOverlap(expandRect(b, -1e-6), r)).toBe(false);
    for (const p of palms) {
      expect(areaAt(areas, p)).toBeNull();
      expect(beaches.some((b) => rectContainsPoint(b, p))).toBe(true);
    }
  });
});
