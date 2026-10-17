import { describe, expect, it } from 'vitest';
import { areaAt } from './areas';
import { gameData } from './data';
import { rectFromCenter, rectsOverlap } from './geometry';
import { allPlacements, placementFootprint } from './props';
import { scatterPlacements, streetlightPlacements } from './streetFurniture';

/** Objets de la ville semés sur les trottoirs et lampadaires de rue (logique pure). */
describe('mobilier urbain', () => {
  const { scatter } = gameData.config.props;
  const scattered = allPlacements(gameData.placements).filter((p) =>
    Object.values(scatter.areas).some((a) => a.props.includes(p.prop) || a.corner === p.prop),
  );

  it('chaque area configurée reçoit des objets, tous dans leur area et hors des routes', () => {
    const areas = [...gameData.areas.values()];
    const roads = gameData.config.map.roads.map((r) => rectFromCenter(r, r));
    for (const id of Object.keys(scatter.areas))
      expect(scattered.filter((p) => p.areaId === id).length, id).toBeGreaterThan(0);
    for (const p of scattered) {
      expect(areaAt(areas, p)?.id, p.prop).toBe(p.areaId);
      const r = rectFromCenter(p, { w: 0.2, d: 0.2 });
      expect(
        roads.some((road) => rectsOverlap(road, r)),
        `${p.prop} ${p.x} ${p.z}`,
      ).toBe(false);
    }
  });

  it('collision seulement pour les gros objets (kiosque, cabine, armoires, bancs, arbres, lampadaire)', () => {
    const solid = new Set(
      scattered
        .filter((p) => placementFootprint(gameData.props.get(p.prop)!, p))
        .map((p) => p.prop),
    );
    for (const id of solid) expect(id, id).toMatch(/kiosque|cabine|armoire|banc|arbre|lampadaire/);
    for (const id of [
      'objet_plot',
      'objet_borne_jaune',
      'objet_panneau_stop',
      'objet_feu_tricolore',
    ])
      expect(gameData.props.get(id)!.collision, id).toBeNull();
  });

  it('déterministe, et deux objets ne se chevauchent jamais', () => {
    const again = scatterPlacements(
      gameData.config,
      gameData.props,
      gameData.areas,
      gameData.locations.values(),
      gameData.quartierLayouts.values(),
      [],
    );
    expect(again.length).toBeGreaterThanOrEqual(scattered.length);
    const boxes = scattered.map((p) => placementFootprint(gameData.props.get(p.prop)!, p));
    boxes.forEach((a, i) =>
      boxes.slice(i + 1).forEach((b) => {
        if (a && b) expect(rectsOverlap(a, b)).toBe(false);
      }),
    );
  });

  it('lampadaires de rue : en quinconce, tournés vers la route, hors croisements', () => {
    const lamps = streetlightPlacements(gameData);
    expect(lamps.length).toBeGreaterThan(20);
    const roads = gameData.config.map.roads.map((r) => rectFromCenter(r, r));
    for (const l of lamps)
      expect(roads.some((r) => rectsOverlap(r, rectFromCenter(l, { w: 0.1, d: 0.1 })))).toBe(false);
  });
});
