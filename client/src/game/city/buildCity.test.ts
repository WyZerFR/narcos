import { describe, expect, it } from 'vitest';
import { areaNeighbors, gameData } from '@narco/shared';
import { SEA_GROUP } from './areaBatches';
import { buildCity } from './buildCity';

describe('ville découpée par area', () => {
  const city = buildCity(gameData);

  it('une paire de géométries par area et une pour la mer, rien d’autre', () => {
    expect([...city.keys()].sort()).toEqual([SEA_GROUP, ...gameData.areas.keys()].sort());
    for (const [key, g] of city) expect(g.solid, key).not.toBeNull();
  });

  it('chaque area a ses murs et ses néons', () => {
    for (const id of gameData.areas.keys()) {
      const g = city.get(id)!;
      expect(g.glow, id).not.toBeNull();
      const tris =
        (g.solid!.getAttribute('position').count + g.glow!.getAttribute('position').count) / 3;
      expect(tris, id).toBeGreaterThan(0);
    }
  });

  it('au plus 2 draw calls de ville par area chargée (area + voisines + mer < 15)', () => {
    const neighbors = areaNeighbors(gameData.areas.values());
    for (const [id, list] of neighbors) {
      const groups = [id, ...list].filter((k) => city.has(k)).length + 1;
      expect(groups * 2, id).toBeLessThan(15);
    }
  });
});
