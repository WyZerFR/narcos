import { describe, expect, it } from 'vitest';
import rawZones from '../data/zones.json';
import { gameData } from './data';
import { isBlocked } from './collision';
import type { Rect } from './geometry';
import { createNavGrid, distancesFrom, cellIndex, cellCenter } from './navgrid';
import { interiorBounds, interiorObstacles, zoneArea } from './zones';
import { fitInteriorZoom } from './framing';

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

    it(`${id} : surface = surface d'origine × facteur², rendu et collisions sur la même pièce`, () => {
      const k = raw.layoutScale!;
      expect(interior.size.w * interior.size.d).toBeCloseTo(raw.size.w * raw.size.d * k * k);
      // le rendu (buildRoom) dessine sol et murs depuis `size` ; les collisions depuis les bornes
      expect(bounds.maxX - bounds.minX).toBeCloseTo(interior.size.w);
      expect(bounds.maxZ - bounds.minZ).toBeCloseTo(interior.size.d);
      expect(zoneArea(gameData, id)!.bounds).toEqual(bounds);
      // apparition, postes et obstacles dans la pièce agrandie
      const inside = (p: { x: number; z: number }) =>
        p.x > bounds.minX && p.x < bounds.maxX && p.z > bounds.minZ && p.z < bounds.maxZ;
      expect(inside(interior.spawn)).toBe(true);
      for (const st of interior.stations) expect(inside(st.position), st.id).toBe(true);
      for (const o of obstacles) {
        expect(o.minX).toBeGreaterThanOrEqual(bounds.minX - 1e-6);
        expect(o.maxX).toBeLessThanOrEqual(bounds.maxX + 1e-6);
        expect(o.minZ).toBeGreaterThanOrEqual(bounds.minZ - 1e-6);
        expect(o.maxZ).toBeLessThanOrEqual(bounds.maxZ + 1e-6);
      }
      // l'aménagement occupe toute la pièce : les postes s'écartent du centre avec le facteur
      const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
      const solid = interior.stations.filter((s) => s.solid);
      const rawSolid = raw.stations.filter((s) => solid.some((t) => t.id === s.id));
      expect(spread(solid.map((s) => s.position.x))).toBeGreaterThan(
        spread(rawSolid.map((s) => s.position.x)),
      );
    });

    it(`${id} : la caméra intérieure cadre toute la pièce agrandie`, () => {
      const cam = config.cameraInterior;
      const zoom = Math.max(
        cam.zoom,
        fitInteriorZoom(interior, cam, 4 / 3, config.interiorFraming),
      );
      const rawZoom = Math.max(
        cam.zoom,
        fitInteriorZoom({ ...interior, size: raw.size }, cam, 4 / 3, config.interiorFraming),
      );
      // vue plus large que la pièce d'origine : l'agrandissement se voit
      expect(zoom).toBeGreaterThan(rawZoom);
      const visibleH = 2 * zoom * Math.tan((cam.fov * Math.PI) / 360);
      expect(visibleH).toBeGreaterThanOrEqual(
        interior.size.d * Math.sin((cam.elevation * Math.PI) / 180),
      );
      expect(visibleH * (4 / 3)).toBeGreaterThanOrEqual(interior.size.w);
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
