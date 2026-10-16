import { rectFromCenter, rectsOverlap, type Rect } from './geometry';
import type { GameConfig } from './schemas';

export type Crosswalk = GameConfig['map']['crosswalks'][number];

/** Emprise au sol d'un passage piéton (bande `width` × `length`). */
export function crosswalkRect(cw: Crosswalk): Rect {
  return cw.axis === 'z'
    ? rectFromCenter(cw, { w: cw.width, d: cw.length })
    : rectFromCenter(cw, { w: cw.length, d: cw.width });
}

/**
 * Passages piétons aux carrefours (pur) : pour chaque route qui en croise une autre, une bande
 * en travers de chaque branche, à `gap` du bord du carrefour, si la branche est assez longue.
 * Aucun sur un passage déjà déclaré (`existing`).
 */
export function intersectionCrosswalks(
  roads: readonly Rect[],
  cfg: GameConfig['map']['autoCrosswalks'],
  existing: readonly Crosswalk[] = [],
): Crosswalk[] {
  if (!cfg.enabled) return [];
  const out: Crosswalk[] = [];
  const taken = existing.map(crosswalkRect);
  roads.forEach((a, i) => {
    const alongX = a.maxX - a.minX >= a.maxZ - a.minZ;
    roads.forEach((b, j) => {
      if (i === j || !rectsOverlap(a, b)) return;
      const off = cfg.gap + cfg.width / 2;
      const candidates: Crosswalk[] = alongX
        ? [Math.max(a.minX, b.minX) - off, Math.min(a.maxX, b.maxX) + off].map((x) => ({
            x,
            z: (a.minZ + a.maxZ) / 2,
            axis: 'z' as const,
            length: a.maxZ - a.minZ,
            width: cfg.width,
          }))
        : [Math.max(a.minZ, b.minZ) - off, Math.min(a.maxZ, b.maxZ) + off].map((z) => ({
            x: (a.minX + a.maxX) / 2,
            z,
            axis: 'x' as const,
            length: a.maxX - a.minX,
            width: cfg.width,
          }));
      for (const cw of candidates) {
        const r = crosswalkRect(cw);
        // la bande doit rester sur la route, hors de tout autre carrefour et passage
        const inside = r.minX >= a.minX && r.maxX <= a.maxX && r.minZ >= a.minZ && r.maxZ <= a.maxZ;
        const crossing = roads.some((o, k) => k !== i && rectsOverlap(o, r));
        if (!inside || crossing || taken.some((t) => rectsOverlap(t, r))) continue;
        taken.push(r);
        out.push(cw);
      }
    });
  });
  return out;
}
