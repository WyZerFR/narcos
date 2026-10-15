import type { BufferGeometry } from 'three';
import {
  areaRects,
  nearestArea,
  rectsOverlap,
  type Area,
  type Rect,
  type Vec2,
} from '@narco/shared';
import { Batch } from './batch';

/** Groupe toujours rendu : la mer autour de l'île. */
export const SEA_GROUP = 'mer';

/** Géométries d'une area (null si rien dans ce matériau). */
export interface AreaGeometry {
  solid: BufferGeometry | null;
  glow: BufferGeometry | null;
}

/**
 * Aiguillage des primitives de la ville vers une paire de batches par area (sol, murs, néons),
 * pour charger et décharger chaque area séparément (2 draw calls par area chargée). L'état
 * `cuttable` suit l'aiguillage : un bloc `furniture()` ou un sol non découpable reste vrai sur
 * l'area suivante.
 */
export class AreaBatches {
  private groups = new Map<string, { solid: Batch; glow: Batch }>();
  private cur: { solid: Batch; glow: Batch };
  private readonly areas: Area[];

  constructor(areas: Iterable<Area>) {
    this.areas = [...areas];
    this.cur = this.group(SEA_GROUP);
  }

  private group(key: string) {
    let g = this.groups.get(key);
    if (!g) {
      g = { solid: new Batch(), glow: new Batch() };
      this.groups.set(key, g);
    }
    return g;
  }

  get solid(): Batch {
    return this.cur.solid;
  }

  get glow(): Batch {
    return this.cur.glow;
  }

  /** Les primitives suivantes vont dans le groupe `key` (id d'area ou `SEA_GROUP`). */
  use(key: string): void {
    const next = this.group(key);
    next.solid.cuttable = this.cur.solid.cuttable;
    next.glow.cuttable = this.cur.glow.cuttable;
    this.cur = next;
  }

  /** Les primitives suivantes vont dans l'area de `p` (la plus proche hors de l'île). */
  at(p: Vec2): void {
    this.use(nearestArea(this.areas, p)?.id ?? SEA_GROUP);
  }

  /** Découpe `r` sur le pavage des areas : un morceau par area traversée (routes longues). */
  split(r: Rect): { areaId: string; rect: Rect }[] {
    const out: { areaId: string; rect: Rect }[] = [];
    for (const a of this.areas)
      for (const t of areaRects(a)) {
        if (!rectsOverlap(t, r)) continue;
        out.push({
          areaId: a.id,
          rect: {
            minX: Math.max(t.minX, r.minX),
            maxX: Math.min(t.maxX, r.maxX),
            minZ: Math.max(t.minZ, r.minZ),
            maxZ: Math.min(t.maxZ, r.maxZ),
          },
        });
      }
    return out;
  }

  build(): Map<string, AreaGeometry> {
    const out = new Map<string, AreaGeometry>();
    for (const [key, g] of this.groups) {
      if (g.solid.empty && g.glow.empty) continue;
      out.set(key, {
        solid: g.solid.empty ? null : g.solid.build(),
        glow: g.glow.empty ? null : g.glow.build(),
      });
    }
    return out;
  }
}
