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
  const inflated = obstacles.map((o) => expandRect(o, radius));
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = bounds.minX + (col + 0.5) * cellSize;
      const z = bounds.minZ + (row + 0.5) * cellSize;
      if (inflated.some((r) => x > r.minX && x < r.maxX && z > r.minZ && z < r.maxZ)) {
        free[row * cols + col] = 0;
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
