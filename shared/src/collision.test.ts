import { describe, expect, it } from 'vitest';
import { isBlocked, moveWithCollisions, resolveCircle } from './collision';
import { validateMove, freshBudget, type MoveRules } from './movement';
import type { Rect } from './geometry';

const wall: Rect = { minX: -1, maxX: 1, minZ: -10, maxZ: 10 }; // mur de 2 m d'épaisseur, axe Z
const bounds = { minX: -50, maxX: 50, minZ: -50, maxZ: 50 };
const R = 0.5;

describe('collisions cercle / rectangles', () => {
  it('sort un cercle qui pénètre un mur par le côté le plus proche', () => {
    expect(resolveCircle({ x: -1.2, z: 0 }, R, [wall])).toEqual({ x: -1.5, z: 0 });
    const inside = resolveCircle({ x: 0.9, z: 0 }, R, [wall]);
    expect(inside.x).toBeCloseTo(1.5);
  });

  it('ne touche pas un cercle déjà libre', () => {
    expect(resolveCircle({ x: -3, z: 0 }, R, [wall])).toEqual({ x: -3, z: 0 });
    expect(isBlocked({ x: -3, z: 0 }, R, [wall])).toBe(false);
    expect(isBlocked({ x: -1.2, z: 0 }, R, [wall])).toBe(true);
  });

  it('glisse le long du mur quand on y entre en diagonale', () => {
    const p = moveWithCollisions({ x: -2, z: 0 }, { x: 0, z: 2 }, R, [wall], bounds);
    expect(p.x).toBeCloseTo(-1.5);
    expect(p.z).toBeCloseTo(2); // la composante le long du mur est conservée
  });

  it('ne traverse pas un mur, même avec un grand pas', () => {
    const p = moveWithCollisions({ x: -3, z: 0 }, { x: 3, z: 0 }, R, [wall], bounds);
    expect(p.x).toBeLessThanOrEqual(-1.5 + 1e-9);
  });

  it('contourne le coin d’un mur', () => {
    const p = moveWithCollisions({ x: -2, z: 11 }, { x: 2, z: 11 }, R, [wall], bounds);
    expect(p.x).toBeCloseTo(2);
  });
});

describe('validateMove avec collisions', () => {
  const rules: MoveRules = {
    maxSpeed: 8,
    toleranceFactor: 1.25,
    maxBurstMs: 600,
    bounds,
    collision: { radius: R, obstacles: [wall] },
  };

  it('refuse un mouvement qui traverse un mur', () => {
    const r = validateMove({ x: -2, z: 0 }, { x: 2, z: 0 }, freshBudget(0, rules), 50, rules);
    expect(r.corrected).toBe(true);
    expect(r.pos.x).toBeCloseTo(-1.5);
  });

  it('refuse une position qui finit dans un mur', () => {
    const r = validateMove({ x: -2, z: 0 }, { x: -1.2, z: 0 }, freshBudget(0, rules), 50, rules);
    expect(r.corrected).toBe(true);
    expect(r.pos.x).toBeCloseTo(-1.5);
  });

  it('accepte tel quel un glissement légitime le long du mur', () => {
    const r = validateMove(
      { x: -1.5, z: 0 },
      { x: -1.5, z: 0.4 },
      freshBudget(0, rules),
      50,
      rules,
    );
    expect(r.corrected).toBe(false);
    expect(r.pos).toEqual({ x: -1.5, z: 0.4 });
  });
});
