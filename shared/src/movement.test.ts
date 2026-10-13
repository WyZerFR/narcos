import { describe, expect, it } from 'vitest';
import { freshBudget, maxBurstMeters, validateMove, type MoveRules } from './movement';

const rules: MoveRules = {
  maxSpeed: 8,
  toleranceFactor: 1.25,
  maxBurstMs: 600,
  bounds: { minX: -45, maxX: 45, minZ: -45, maxZ: 45 },
};

describe('validateMove', () => {
  it('accepte un pas normal à vitesse de course', () => {
    const budget = { meters: 0, lastMs: 0 };
    const r = validateMove({ x: 0, z: 0 }, { x: 0.4, z: 0 }, budget, 50, rules); // 8 m/s * 50 ms
    expect(r.corrected).toBe(false);
    expect(r.pos).toEqual({ x: 0.4, z: 0 });
  });

  it('corrige une téléportation en raccourcissant le déplacement', () => {
    const r = validateMove({ x: 0, z: 0 }, { x: 40, z: 0 }, freshBudget(0, rules), 50, rules);
    expect(r.corrected).toBe(true);
    expect(r.pos.x).toBeCloseTo(maxBurstMeters(rules));
    expect(r.pos.z).toBe(0);
    expect(r.budget.meters).toBeCloseTo(0);
  });

  it('absorbe des messages groupés par la gigue réseau', () => {
    let budget = { meters: 0, lastMs: 0 };
    let pos = { x: 0, z: 0 };
    // 100 ms de silence puis deux pas de 50 ms arrivés quasi en même temps.
    for (const [t, x] of [
      [100, 0.4],
      [102, 0.8],
    ] as const) {
      const r = validateMove(pos, { x, z: 0 }, budget, t, rules);
      expect(r.corrected).toBe(false);
      pos = r.pos;
      budget = r.budget;
    }
  });

  it('empêche de dépasser la vitesse max sur la durée', () => {
    let budget = freshBudget(0, rules);
    let pos = { x: -40, z: 0 };
    for (let t = 50; t <= 5000; t += 50) {
      const r = validateMove(pos, { x: pos.x + 2, z: 0 }, budget, t, rules); // 40 m/s demandés
      pos = r.pos;
      budget = r.budget;
    }
    const maxAllowed = -40 + maxBurstMeters(rules) + 8 * 1.25 * 5;
    expect(pos.x).toBeLessThanOrEqual(maxAllowed + 1e-6);
  });

  it('ramène dans les bornes de la carte', () => {
    const r = validateMove({ x: 44.9, z: 0 }, { x: 45.3, z: 0 }, freshBudget(0, rules), 50, rules);
    expect(r.corrected).toBe(true);
    expect(r.pos.x).toBe(45);
  });

  it('refuse les valeurs non finies', () => {
    const r = validateMove(
      { x: 1, z: 2 },
      { x: NaN, z: Infinity },
      freshBudget(0, rules),
      50,
      rules,
    );
    expect(r).toMatchObject({ pos: { x: 1, z: 2 }, corrected: true });
  });
});
