import { areaAt, areasEnvelope, polygonContainsPoint } from './areas';
import type { Rect, Vec2 } from './geometry';
import { seededRng } from './quartiers';
import type { Area, IslandParams } from './schemas';

/**
 * Côte de l'île : contour des areas (toutes, l'aéroport verrouillé compris : c'est de la
 * terre), plages et palmiers. Pur et déterministe (`config.island.seed`) : le client en tire la
 * géométrie (mer, falaises, sable), les tests vérifient que rien n'est marchable au-delà et que
 * rien n'est posé sur l'eau. La collision ne lit pas ce module : hors des areas marchables,
 * `outsideAreas` bloque déjà tout.
 */

/** Segment de côte, avec sa normale sortante (vers la mer, axe X ou Z). */
export interface CoastEdge {
  a: Vec2;
  b: Vec2;
  nx: -1 | 0 | 1;
  nz: -1 | 0 | 1;
}

export interface IslandLayout {
  coast: CoastEdge[];
  /** Bandes de sable au pied des falaises, côté mer (jamais marchables). */
  beaches: Rect[];
  /** Palmiers, posés sur le sable. */
  palms: Vec2[];
}

/** Contour de l'île : bords entre une case de terre et la mer, fusionnés bout à bout. */
export function coastline(areas: Iterable<Area>): CoastEdge[] {
  const list = [...areas];
  const env = areasEnvelope(list);
  const cuts = (lo: number, hi: number, values: number[]) =>
    [...new Set([lo, hi, ...values.filter((v) => v > lo && v < hi)])].sort((a, b) => a - b);
  const xs = cuts(
    env.minX,
    env.maxX,
    list.flatMap((a) => a.polygon.map((p) => p.x)),
  );
  const zs = cuts(
    env.minZ,
    env.maxZ,
    list.flatMap((a) => a.polygon.map((p) => p.z)),
  );
  const land = (i: number, j: number) =>
    i >= 0 &&
    j >= 0 &&
    i + 1 < xs.length &&
    j + 1 < zs.length &&
    list.some((a) =>
      polygonContainsPoint(a.polygon, {
        x: (xs[i]! + xs[i + 1]!) / 2,
        z: (zs[j]! + zs[j + 1]!) / 2,
      }),
    );
  // bords unitaires regroupés par droite porteuse et normale, puis fusionnés
  const lines = new Map<string, { edge: CoastEdge; from: number; to: number }[]>();
  const push = (edge: CoastEdge, from: number, to: number) => {
    const key = edge.nx !== 0 ? `x${edge.a.x}:${edge.nx}` : `z${edge.a.z}:${edge.nz}`;
    lines.set(key, [...(lines.get(key) ?? []), { edge, from, to }]);
  };
  for (let i = 0; i + 1 < xs.length; i++)
    for (let j = 0; j + 1 < zs.length; j++) {
      if (!land(i, j)) continue;
      const [x0, x1, z0, z1] = [xs[i]!, xs[i + 1]!, zs[j]!, zs[j + 1]!];
      if (!land(i - 1, j))
        push({ a: { x: x0, z: z0 }, b: { x: x0, z: z1 }, nx: -1, nz: 0 }, z0, z1);
      if (!land(i + 1, j)) push({ a: { x: x1, z: z0 }, b: { x: x1, z: z1 }, nx: 1, nz: 0 }, z0, z1);
      if (!land(i, j - 1))
        push({ a: { x: x0, z: z0 }, b: { x: x1, z: z0 }, nx: 0, nz: -1 }, x0, x1);
      if (!land(i, j + 1)) push({ a: { x: x0, z: z1 }, b: { x: x1, z: z1 }, nx: 0, nz: 1 }, x0, x1);
    }
  const out: CoastEdge[] = [];
  for (const parts of lines.values()) {
    parts.sort((p, q) => p.from - q.from);
    let run: { edge: CoastEdge; from: number; to: number } | null = null;
    const flush = () => {
      if (!run) return;
      const { edge, from, to } = run;
      out.push(
        edge.nx !== 0
          ? { ...edge, a: { x: edge.a.x, z: from }, b: { x: edge.a.x, z: to } }
          : { ...edge, a: { x: from, z: edge.a.z }, b: { x: to, z: edge.a.z } },
      );
    };
    for (const p of parts) {
      if (run && run.to === p.from) run.to = p.to;
      else {
        flush();
        run = { ...p };
      }
    }
    flush();
  }
  return out;
}

/** Bande de largeur `w` le long d'un bord, côté mer, entre les fractions `t0` et `t1`. */
function seaStrip(e: CoastEdge, w: number, t0 = 0, t1 = 1): Rect {
  const lerp = (u: number) => ({ x: e.a.x + (e.b.x - e.a.x) * u, z: e.a.z + (e.b.z - e.a.z) * u });
  const [p, q] = [lerp(t0), lerp(t1)];
  const far = { x: p.x + e.nx * w, z: p.z + e.nz * w };
  return {
    minX: Math.min(p.x, q.x, far.x),
    maxX: Math.max(p.x, q.x, far.x),
    minZ: Math.min(p.z, q.z, far.z),
    maxZ: Math.max(p.z, q.z, far.z),
  };
}

/**
 * Plages (une côte sur deux environ, tirée par la graine) et palmiers sur le sable, jamais
 * dans une area ni au-delà du sable.
 */
export function islandLayout(areas: Iterable<Area>, p: IslandParams): IslandLayout {
  const list = [...areas];
  const coast = coastline(list);
  const rng = seededRng(p.seed);
  const beaches: Rect[] = [];
  const palms: Vec2[] = [];
  for (const e of coast) {
    const len = Math.hypot(e.b.x - e.a.x, e.b.z - e.a.z);
    if (rng() >= p.beachChance || len < p.minBeachLength) continue;
    // sable en retrait des extrémités : aucun recouvrement d'une plage voisine au coin
    const inset = Math.min(p.beachWidth, len / 4) / len;
    beaches.push(seaStrip(e, p.beachWidth, inset, 1 - inset));
    for (let t = p.palmSpacing / 2; t < len - p.palmSpacing / 2; t += p.palmSpacing) {
      if (rng() >= p.palmChance) continue;
      const u = t / len;
      if (u < inset || u > 1 - inset) continue;
      const d = p.beachWidth * (0.3 + 0.4 * rng());
      const palm = {
        x: e.a.x + (e.b.x - e.a.x) * u + e.nx * d,
        z: e.a.z + (e.b.z - e.a.z) * u + e.nz * d,
      };
      if (areaAt(list, palm) === null) palms.push(palm);
    }
  }
  return { coast, beaches, palms };
}
