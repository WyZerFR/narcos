import { describe, expect, it } from 'vitest';
import rawZones from '../data/zones.json';
import { gameData } from './data';
import { isBlocked } from './collision';
import type { Rect } from './geometry';
import { createNavGrid, distancesFrom, cellIndex, cellCenter } from './navgrid';
import { interiorBounds, interiorObstacles, zoneArea } from './zones';

const { config } = gameData;
const R = config.world.playerRadius;
const CORRIDOR = 2 * R + config.collision.passageMargin;
const SHOPS = ['shop', 'grocery', 'bank'];
const CELL = 0.1;

/** Écart entre deux rectangles (0 s'ils se touchent ou se chevauchent). */
function gap(a: Rect, b: Rect): number {
  const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
  const dz = Math.max(0, a.minZ - b.maxZ, b.minZ - a.maxZ);
  return Math.hypot(dx, dz);
}

describe('magasins agrandis', () => {
  for (const id of SHOPS) {
    const interior = gameData.interiors.get(id)!;
    const raw = rawZones.interiors.find((i) => i.id === id)!;
    const obstacles = interiorObstacles(interior);
    const bounds = interiorBounds(interior);
    // corps du joueur entièrement dans la pièce, avec la marge de couloir
    const inner = {
      minX: bounds.minX + R,
      maxX: bounds.maxX - R,
      minZ: bounds.minZ + R,
      maxZ: bounds.maxZ - R,
    };
    const grid = createNavGrid(inner, obstacles, R + config.collision.passageMargin / 2, CELL);
    const dist = distancesFrom(grid, interior.spawn);

    it(`${id} : agrandi du facteur de zones.json`, () => {
      expect(raw.layoutScale).toBeGreaterThan(1);
      expect(interior.size.w).toBeCloseTo(raw.size.w * raw.layoutScale!);
      expect(interior.size.d).toBeCloseTo(raw.size.d * raw.layoutScale!);
    });

    it(`${id} : couloirs d'au moins diamètre + marge entre postes et murs`, () => {
      const walls: Rect[] = [
        { minX: bounds.minX - 1, maxX: bounds.minX, minZ: bounds.minZ, maxZ: bounds.maxZ },
        { minX: bounds.maxX, maxX: bounds.maxX + 1, minZ: bounds.minZ, maxZ: bounds.maxZ },
        { minX: bounds.minX, maxX: bounds.maxX, minZ: bounds.minZ - 1, maxZ: bounds.minZ },
        { minX: bounds.minX, maxX: bounds.maxX, minZ: bounds.maxZ, maxZ: bounds.maxZ + 1 },
      ];
      for (const [i, a] of obstacles.entries())
        for (const b of [...obstacles.slice(i + 1), ...walls]) {
          const g = gap(a, b);
          // collé (aucun passage) ou vrai couloir
          expect(g < 1e-6 || g >= CORRIDOR - 1e-6, `écart ${g.toFixed(2)} m`).toBe(true);
        }
    });

    it(`${id} : la porte est libre et chaque poste est atteignable depuis la porte`, () => {
      const exit = interior.stations.find((s) => s.kind === 'exit')!;
      expect(isBlocked(interior.spawn, R, obstacles)).toBe(false);
      for (const st of interior.stations) {
        let reachable = false;
        for (let i = 0; i < dist.length && !reachable; i++) {
          if (!Number.isFinite(dist[i]!)) continue;
          const c = cellCenter(grid, i);
          if (Math.hypot(c.x - st.position.x, c.z - st.position.z) <= st.interactRadius)
            reachable = true;
        }
        expect(reachable, `${st.id} inaccessible`).toBe(true);
      }
      expect(Number.isFinite(dist[cellIndex(grid, interior.spawn)]!)).toBe(true);
      expect(Math.abs(exit.position.z + exit.size.d / 2 - bounds.maxZ)).toBeLessThan(1e-6);
    });

    it(`${id} : aucun joueur coincé autour des postes`, () => {
      const area = zoneArea(gameData, id)!;
      const free = createNavGrid(area.bounds, area.obstacles, R, CELL);
      const reach = distancesFrom(free, interior.spawn);
      for (const st of interior.stations.filter((s) => s.solid))
        for (let k = 0; k < 16; k++) {
          const a = (k * Math.PI) / 8;
          const p = {
            x: st.position.x + Math.cos(a) * st.interactRadius * 0.9,
            z: st.position.z + Math.sin(a) * st.interactRadius * 0.9,
          };
          const idx = cellIndex(free, p);
          if (idx < 0 || free.free[idx] !== 1) continue; // dans un obstacle ou hors pièce
          expect(Number.isFinite(reach[idx]!), `${st.id} angle ${k}`).toBe(true);
        }
    });
  }
});
