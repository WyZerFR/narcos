import { expandRect, type Rect, type Vec2 } from './geometry';
import type { Bounds } from './schemas';

/**
 * Grille de navigation : cases libres pour un cercle de rayon `radius` (obstacles gonflés),
 * plus courts chemins en 8 directions. Sert aux tests de carte (accessibilité, temps de
 * traversée) et servira aux patrouilles de police.
 */
export interface NavGrid {
  cols: number;
  rows: number;
  cellSize: number;
  bounds: Bounds;
  /** 1 = libre, 0 = bloquée. */
  free: Uint8Array;
}

export function createNavGrid(
  bounds: Bounds,
  obstacles: readonly Rect[],
  radius: number,
  cellSize: number,
): NavGrid {
  const cols = Math.floor((bounds.maxX - bounds.minX) / cellSize);
  const rows = Math.floor((bounds.maxZ - bounds.minZ) / cellSize);
  const free = new Uint8Array(cols * rows).fill(1);
  // chaque obstacle gonflé bloque les cases dont le centre est strictement dedans (balayage
  // de sa seule emprise : l'île entière reste rapide à construire)
  const center = (i: number, min: number) => min + (i + 0.5) * cellSize;
  for (const o of obstacles) {
    const r = expandRect(o, radius);
    const c0 = Math.max(0, Math.floor((r.minX - bounds.minX) / cellSize - 0.5));
    const c1 = Math.min(cols - 1, Math.ceil((r.maxX - bounds.minX) / cellSize - 0.5));
    const r0 = Math.max(0, Math.floor((r.minZ - bounds.minZ) / cellSize - 0.5));
    const r1 = Math.min(rows - 1, Math.ceil((r.maxZ - bounds.minZ) / cellSize - 0.5));
    for (let row = r0; row <= r1; row++) {
      const z = center(row, bounds.minZ);
      if (!(z > r.minZ && z < r.maxZ)) continue;
      for (let col = c0; col <= c1; col++) {
        const x = center(col, bounds.minX);
        if (x > r.minX && x < r.maxX) free[row * cols + col] = 0;
      }
    }
  }
  return { cols, rows, cellSize, bounds, free };
}

export function cellIndex(grid: NavGrid, p: Vec2): number {
  const col = Math.floor((p.x - grid.bounds.minX) / grid.cellSize);
  const row = Math.floor((p.z - grid.bounds.minZ) / grid.cellSize);
  if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return -1;
  return row * grid.cols + col;
}

export function isFreeAt(grid: NavGrid, p: Vec2): boolean {
  const i = cellIndex(grid, p);
  return i >= 0 && grid.free[i] === 1;
}

/** Distances (m) depuis `start` vers toutes les cases (Dijkstra 8 directions ; Infinity = inaccessible). */
export function distancesFrom(grid: NavGrid, start: Vec2): Float64Array {
  const { cols, rows, free, cellSize } = grid;
  const dist = new Float64Array(cols * rows).fill(Infinity);
  const startIdx = cellIndex(grid, start);
  if (startIdx < 0 || free[startIdx] !== 1) return dist;

  const heap = new MinHeap();
  dist[startIdx] = 0;
  heap.push(startIdx, 0);
  const diag = Math.SQRT2 * cellSize;
  const moves = [
    [1, 0, cellSize],
    [-1, 0, cellSize],
    [0, 1, cellSize],
    [0, -1, cellSize],
    [1, 1, diag],
    [1, -1, diag],
    [-1, 1, diag],
    [-1, -1, diag],
  ] as const;

  while (heap.size > 0) {
    const [idx, d] = heap.pop();
    if (d > dist[idx]!) continue;
    const col = idx % cols;
    const row = (idx - col) / cols;
    for (const [dc, dr, cost] of moves) {
      const c = col + dc;
      const r = row + dr;
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
      const n = r * cols + c;
      if (free[n] !== 1) continue;
      // Pas de diagonale qui coupe un coin bloqué.
      if (dc !== 0 && dr !== 0 && (free[row * cols + c] !== 1 || free[r * cols + col] !== 1))
        continue;
      const nd = d + cost;
      if (nd < dist[n]!) {
        dist[n] = nd;
        heap.push(n, nd);
      }
    }
  }
  return dist;
}

/** Tas binaire minimal (index, priorité). */
class MinHeap {
  private ids: number[] = [];
  private prio: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, p: number): void {
    this.ids.push(id);
    this.prio.push(p);
    let i = this.ids.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.prio[parent]! <= this.prio[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): [number, number] {
    const top: [number, number] = [this.ids[0]!, this.prio[0]!];
    const lastId = this.ids.pop()!;
    const lastP = this.prio.pop()!;
    if (this.ids.length > 0) {
      this.ids[0] = lastId;
      this.prio[0] = lastP;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.ids.length && this.prio[l]! < this.prio[m]!) m = l;
        if (r < this.ids.length && this.prio[r]! < this.prio[m]!) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.ids[a], this.ids[b]] = [this.ids[b]!, this.ids[a]!];
    [this.prio[a], this.prio[b]] = [this.prio[b]!, this.prio[a]!];
  }
}

/** Centre de la case `idx`. */
export function cellCenter(grid: NavGrid, idx: number): Vec2 {
  const col = idx % grid.cols;
  const row = (idx - col) / grid.cols;
  return {
    x: grid.bounds.minX + (col + 0.5) * grid.cellSize,
    z: grid.bounds.minZ + (row + 0.5) * grid.cellSize,
  };
}

/** Le segment a → b ne traverse-t-il que des cases libres (échantillonné à la demi-case) ? */
export function isSegmentFree(grid: NavGrid, a: Vec2, b: Vec2): boolean {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(1, Math.ceil(len / (grid.cellSize / 2)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (!isFreeAt(grid, { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t })) return false;
  }
  return true;
}

/**
 * Plus court chemin de `from` vers `to` : descente du champ de distances calculé depuis `to`
 * (réutilisable pour plusieurs départs vers la même cible), puis lissage en lignes droites.
 * Renvoie les points de passage (sans `from`, `to` en dernier), ou null si inaccessible.
 */
export function findPath(
  grid: NavGrid,
  from: Vec2,
  to: Vec2,
  field: Float64Array = distancesFrom(grid, to),
): Vec2[] | null {
  let idx = cellIndex(grid, from);
  if (idx < 0 || !Number.isFinite(field[idx]!)) return null;
  const raw: Vec2[] = [];
  const { cols, rows } = grid;
  while (field[idx]! > 0) {
    const col = idx % cols;
    const row = (idx - col) / cols;
    let best = idx;
    for (let dc = -1; dc <= 1; dc++)
      for (let dr = -1; dr <= 1; dr++) {
        const c = col + dc;
        const r = row + dr;
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
        const n = r * cols + c;
        if (field[n]! < field[best]!) best = n;
      }
    if (best === idx) return null;
    idx = best;
    raw.push(cellCenter(grid, idx));
  }
  raw.push(to);
  // lissage : depuis chaque point, on saute au plus lointain visible en ligne droite
  const path: Vec2[] = [];
  let anchor = from;
  let i = 0;
  while (i < raw.length) {
    let j = raw.length - 1;
    while (j > i && !isSegmentFree(grid, anchor, raw[j]!)) j--;
    path.push(raw[j]!);
    anchor = raw[j]!;
    i = j + 1;
  }
  return path;
}
