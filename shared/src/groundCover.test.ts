import { describe, expect, it } from 'vitest';
import { gameData } from './data';
import { dirtPaths, groundCover, valueNoise } from './groundCover';
import { reservedGround } from './greenery';
import { isBlocked, obstaclesFrom } from './collision';
import { expandRect, rectContainsPoint, rectFromCenter, rectsOverlap } from './geometry';
import { interactionPoint } from './locations';
import { areaAt, walkableAreas } from './areas';

/** Herbe vivante du thème jour : bruit déterministe, couvert au sol et chemins seulement sur l'herbe. */
const grass = gameData.config.theme.day.grass!;
const obstacles = obstaclesFrom(gameData);
const walkable = walkableAreas(gameData.areas.values());
const reserved = reservedGround(gameData);

describe('herbe vivante', () => {
  it('bruit déterministe, dans [0, 1], qui varie', () => {
    const a = valueNoise(grass.seed, grass.noiseScale);
    const b = valueNoise(grass.seed, grass.noiseScale);
    const values = Array.from({ length: 200 }, (_, i) => a(i * 3.7, i * 1.3));
    expect(values).toEqual(Array.from({ length: 200 }, (_, i) => b(i * 3.7, i * 1.3)));
    for (const v of values) expect(v >= 0 && v <= 1).toBe(true);
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(0.4);
    expect(grass.colors.length).toBeGreaterThanOrEqual(3);
  });

  it('touffes, fleurs et pierres : seulement sur l’herbe, loin des portes et des passages étroits', () => {
    const cover = groundCover(gameData, grass);
    const all = [...cover.tufts, ...cover.flowers, ...cover.stones];
    expect(cover.tufts.length).toBeGreaterThan(100);
    expect(cover.flowers.length).toBeGreaterThan(50);
    expect(cover.stones.length).toBeGreaterThan(20);
    const doors = [...gameData.locations.values()].map(interactionPoint);
    const paths = dirtPaths(gameData, grass);
    for (const p of all) {
      expect(areaAt(walkable, p)).not.toBeNull();
      expect(reserved.some((r) => rectContainsPoint(r, p))).toBe(false);
      expect(paths.some((r) => rectContainsPoint(r, p))).toBe(false);
      expect(isBlocked(p, grass.clearance, obstacles)).toBe(false);
      for (const d of doors)
        expect(Math.hypot(d.x - p.x, d.z - p.z)).toBeGreaterThanOrEqual(grass.doorClearance);
    }
    // densité par area : une area à 0 n'a rien
    expect(Object.keys(grass.density).every((id) => gameData.areas.has(id))).toBe(true);
    expect(groundCover(gameData, grass)).toEqual(cover);
  });

  it('chemins de terre : décoratifs, ni sur un obstacle ni sur une route', () => {
    const paths = dirtPaths(gameData, grass);
    expect(paths.length).toBeGreaterThan(5);
    const roads = gameData.config.map.roads.map((r) => rectFromCenter(r, r));
    for (const p of paths) {
      expect(obstacles.some((o) => rectsOverlap(o, p))).toBe(false);
      expect(roads.some((r) => rectsOverlap(expandRect(r, -0.01), p))).toBe(false);
      expect(Math.max(p.maxX - p.minX, p.maxZ - p.minZ)).toBeLessThanOrEqual(grass.pathMaxLength);
    }
    // aucune collision ajoutée : obstacles identiques
    expect(obstaclesFrom(gameData)).toEqual(obstacles);
  });
});
