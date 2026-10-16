import { describe, expect, it } from 'vitest';
import { gameData } from './data';
import { greeneryLayout } from './greenery';
import { intersectionCrosswalks, crosswalkRect } from './crosswalks';
import { isBlocked, obstaclesFrom } from './collision';
import { expandRect, rectContainsPoint, rectFromCenter, rectsOverlap } from './geometry';
import { interactionPoint } from './locations';
import { areaAt, walkableAreas } from './areas';

/**
 * Sol et verdure du thème jour : passages piétons générés aux carrefours, arbres et buissons
 * sans collision qui ne touchent ni route, ni trottoir, ni porte, ni obstacle.
 */
const { config } = gameData;
const g = config.decor.greenery;
const roads = config.map.roads.map((r) => rectFromCenter(r, r));

describe('verdure générée', () => {
  const { trees, bushes } = greeneryLayout(gameData);
  const all = [...trees, ...bushes];
  const obstacles = obstaclesFrom(gameData);
  const walkable = walkableAreas(gameData.areas.values());

  it('nombreux arbres et buissons, le long des avenues et dans les parcelles', () => {
    expect(trees.length).toBeGreaterThan(config.decor.trees.length * 2);
    expect(bushes.length).toBeGreaterThan(10);
    for (const t of trees) expect(t.scale).toBeGreaterThanOrEqual(g.scale.min);
  });

  it('jamais sur une route, un trottoir, une porte ou un obstacle, toujours dans une area', () => {
    const doors = [...gameData.locations.values()].map(interactionPoint);
    for (const p of all) {
      expect(areaAt(walkable, p), `${p.x},${p.z}`).not.toBeNull();
      for (const r of roads)
        expect(rectContainsPoint(expandRect(r, config.map.sidewalkWidth), p)).toBe(false);
      for (const l of gameData.quartierLayouts.values())
        for (const r of [...l.roads, ...l.sidewalks, l.plaza])
          expect(rectContainsPoint(r, p)).toBe(false);
      for (const d of doors)
        expect(Math.hypot(d.x - p.x, d.z - p.z)).toBeGreaterThanOrEqual(g.doorClearance);
      expect(isBlocked(p, g.clearance, obstacles)).toBe(false);
    }
  });

  it('décor sans collision : obstacles inchangés, déterministe', () => {
    expect(obstaclesFrom(gameData)).toEqual(obstacles);
    expect(greeneryLayout({ ...gameData, config: { ...config } })).toEqual({ trees, bushes });
  });
});

describe('passages piétons aux carrefours', () => {
  const auto = intersectionCrosswalks(roads, config.map.autoCrosswalks, config.map.crosswalks);

  it('sur une route, contre un carrefour, sans doublon avec les passages déclarés', () => {
    expect(auto.length).toBeGreaterThan(4);
    const declared = config.map.crosswalks.map(crosswalkRect);
    auto.forEach((cw, i) => {
      const r = crosswalkRect(cw);
      expect(roads.filter((road) => rectsOverlap(road, r))).toHaveLength(1);
      // un carrefour à moins de gap + largeur
      const near = expandRect(r, config.map.autoCrosswalks.gap + 0.01);
      expect(roads.filter((road) => rectsOverlap(road, near)).length).toBeGreaterThanOrEqual(2);
      for (const d of declared) expect(rectsOverlap(d, r)).toBe(false);
      auto.forEach((o, j) => j !== i && expect(rectsOverlap(crosswalkRect(o), r)).toBe(false));
    });
    expect(intersectionCrosswalks(roads, { ...config.map.autoCrosswalks, enabled: false })).toEqual(
      [],
    );
  });
});
