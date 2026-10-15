import { moveWithCollisions } from './collision';
import type { Rect, Vec2 } from './geometry';
import type { Bounds } from './schemas';

/**
 * Lissages indépendants du framerate (caméra, rotation, joueurs distants) et réconciliation
 * de la position prédite avec les corrections du serveur. Logique pure, testée en Vitest.
 */

/** Fraction à parcourir vers la cible pendant `dt` (s) pour une raideur `stiffness` (1/s). */
export function smoothFactor(stiffness: number, dt: number): number {
  return 1 - Math.exp(-stiffness * Math.max(0, dt));
}

/** Écart d'angle le plus court de `a` vers `b` (rad, dans ]-π, π]). */
export function angleDelta(a: number, b: number): number {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}

/** Rapproche l'angle `a` de `b` par le chemin le plus court, d'une fraction `t`. */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + angleDelta(a, b) * t;
}

// ---------------------------------------------------------------- joueurs distants

export interface Snapshot {
  /** Instant de réception (ms, horloge locale). */
  t: number;
  x: number;
  z: number;
  rotY: number;
}

/** Instantanés gardés au plus (quelques centaines de ms à 20 Hz). */
const MAX_SNAPSHOTS = 16;

/**
 * Tampon d'instantanés d'une entité distante, lu avec un retard fixe : la position affichée
 * est interpolée entre les deux instantanés qui encadrent `now - delay`, donc continue même si
 * les paquets arrivent par à-coups. Jamais de saut direct vers le dernier reçu.
 */
export class SnapshotBuffer {
  private list: Snapshot[] = [];

  /**
   * @param restGapMs intervalle normal entre deux instantanés (cadence des patchs) : après un
   * arrêt plus long, l'entité est supposée immobile jusqu'à `restGapMs` avant le nouveau.
   */
  constructor(private restGapMs = Infinity) {}

  get size(): number {
    return this.list.length;
  }

  /** Ajoute un instantané s'il apporte une nouvelle position (horodatage croissant). */
  push(s: Snapshot): void {
    const last = this.list[this.list.length - 1];
    if (last && s.t <= last.t) {
      // même instant : on remplace (deux patchs dans la même frame)
      this.list[this.list.length - 1] = { ...s, t: last.t };
      return;
    }
    if (last && s.t - last.t > this.restGapMs) this.list.push({ ...last, t: s.t - this.restGapMs });
    this.list.push({ ...s });
    if (this.list.length > MAX_SNAPSHOTS) this.list.shift();
  }

  /** Position à l'instant `renderTime` (ms) : interpolée, figée sur le premier / dernier connu. */
  sample(renderTime: number): Omit<Snapshot, 't'> | null {
    const list = this.list;
    const first = list[0];
    if (!first) return null;
    if (renderTime <= first.t) return { x: first.x, z: first.z, rotY: first.rotY };
    for (let i = 1; i < list.length; i++) {
      const b = list[i]!;
      if (renderTime > b.t) continue;
      const a = list[i - 1]!;
      const k = (renderTime - a.t) / (b.t - a.t);
      // les instantanés trop anciens ne servent plus
      if (i > 2) list.splice(0, i - 2);
      return {
        x: a.x + (b.x - a.x) * k,
        z: a.z + (b.z - a.z) * k,
        rotY: lerpAngle(a.rotY, b.rotY, k),
      };
    }
    const last = list[list.length - 1]!;
    return { x: last.x, z: last.z, rotY: last.rotY };
  }
}

// ---------------------------------------------------------------- réconciliation

export interface ReconcileRules {
  /** En dessous (m), une correction est ignorée : le serveur garde son écart minime. */
  ignoreDistance: number;
  /** Au-delà (m), recalage immédiat (téléportation, grosse désynchronisation). */
  snapDistance: number;
  /** Raideur (1/s) du fondu entre les deux seuils. */
  blendStiffness: number;
}

export interface Collider {
  radius: number;
  obstacles: readonly Rect[];
  bounds: Bounds;
  maxSubStep: number;
}

export type CorrectionKind = 'ignore' | 'blend' | 'snap';

/**
 * Réconciliation de la position prédite : chaque envoi est mémorisé avec son `seq`. Une
 * correction porte la position retenue par le serveur pour ce `seq` ; on n'applique que
 * l'écart entre elle et ce qu'on avait envoyé (le chemin parcouru depuis est conservé), en
 * douceur sous `snapDistance`, et pas du tout sous `ignoreDistance`.
 */
export class Reconciler {
  private sent: { seq: number; x: number; z: number }[] = [];
  /** Écart restant à résorber en fondu. */
  pending: Vec2 = { x: 0, z: 0 };

  constructor(private rules: ReconcileRules) {}

  reset(): void {
    this.sent = [];
    this.pending = { x: 0, z: 0 };
  }

  recordSent(seq: number, pos: Vec2): void {
    this.sent.push({ seq, x: pos.x, z: pos.z });
    if (this.sent.length > 64) this.sent.shift();
  }

  /**
   * Traite une correction. Renvoie la nouvelle position (inchangée sauf recalage immédiat) ;
   * en fondu, l'écart est ajouté à `pending` et résorbé par `step`.
   */
  correct(
    current: Vec2,
    correction: { x: number; z: number; seq: number },
    col: Collider,
  ): { kind: CorrectionKind; pos: Vec2 } {
    const idx = this.sent.findIndex((s) => s.seq === correction.seq);
    const base = idx >= 0 ? this.sent[idx]! : { x: current.x, z: current.z };
    if (idx >= 0) this.sent.splice(0, idx + 1);
    const dx = correction.x - base.x;
    const dz = correction.z - base.z;
    const dist = Math.hypot(dx, dz);
    if (dist < this.rules.ignoreDistance) return { kind: 'ignore', pos: current };
    if (dist < this.rules.snapDistance) {
      this.pending = { x: this.pending.x + dx, z: this.pending.z + dz };
      return { kind: 'blend', pos: current };
    }
    // Recalage : position du serveur, puis le chemin fait depuis cet envoi (sans traverser).
    this.pending = { x: 0, z: 0 };
    this.sent = [];
    const pos = moveWithCollisions(
      correction,
      { x: correction.x + current.x - base.x, z: correction.z + current.z - base.z },
      col.radius,
      col.obstacles,
      col.bounds,
      col.maxSubStep,
    );
    return { kind: 'snap', pos };
  }

  /** Résorbe une part de l'écart en attente (sans traverser de mur). */
  step(current: Vec2, dt: number, col: Collider): Vec2 {
    const { pending } = this;
    if (pending.x === 0 && pending.z === 0) return current;
    const k = smoothFactor(this.rules.blendStiffness, dt);
    let part = { x: pending.x * k, z: pending.z * k };
    if (Math.hypot(pending.x - part.x, pending.z - part.z) < 1e-3) part = { ...pending };
    this.pending = { x: pending.x - part.x, z: pending.z - part.z };
    return moveWithCollisions(
      current,
      { x: current.x + part.x, z: current.z + part.z },
      col.radius,
      col.obstacles,
      col.bounds,
      col.maxSubStep,
    );
  }
}
