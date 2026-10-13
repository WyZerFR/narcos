import type { Bounds } from './schemas';

export interface Vec2 {
  x: number;
  z: number;
}

export interface MoveRules {
  /** Vitesse max autorisée (m/s), en pratique la vitesse de course. */
  maxSpeed: number;
  /** Marge pour la gigue réseau / l'imprécision du client (>= 1). */
  toleranceFactor: number;
  /** Plafond du crédit de déplacement accumulable (ms de course max d'un coup). */
  maxBurstMs: number;
  bounds: Bounds;
}

/** Crédit de déplacement d'un joueur, conservé par le serveur entre deux messages. */
export interface MoveBudget {
  /** Distance (m) que le joueur a encore le droit de parcourir. */
  meters: number;
  /** Horodatage (ms) de la dernière mise à jour du crédit. */
  lastMs: number;
}

export interface MoveResult {
  pos: Vec2;
  budget: MoveBudget;
  /** true si la position proposée a été refusée ou ajustée : le client doit se recaler. */
  corrected: boolean;
}

export function clampToBounds(p: Vec2, b: Bounds): Vec2 {
  return {
    x: Math.min(b.maxX, Math.max(b.minX, p.x)),
    z: Math.min(b.maxZ, Math.max(b.minZ, p.z)),
  };
}

export function maxBurstMeters(rules: MoveRules): number {
  return (rules.maxSpeed * rules.toleranceFactor * rules.maxBurstMs) / 1000;
}

export function freshBudget(nowMs: number, rules: MoveRules): MoveBudget {
  return { meters: maxBurstMeters(rules), lastMs: nowMs };
}

const EPSILON = 1e-6;

/**
 * Valide une position proposée par le client (serveur autoritaire).
 *
 * Modèle « seau à jetons » : le crédit de distance se recharge à `maxSpeed * toleranceFactor`
 * et plafonne à `maxBurstMs` de course, ce qui absorbe la gigue réseau (messages groupés)
 * sans autoriser de téléportation. Un déplacement trop long est raccourci dans sa direction ;
 * une position hors carte est ramenée dans les bornes ; une valeur non finie est refusée.
 */
export function validateMove(
  current: Vec2,
  proposed: Vec2,
  budget: MoveBudget,
  nowMs: number,
  rules: MoveRules,
): MoveResult {
  const elapsed = Math.max(0, nowMs - budget.lastMs);
  const refilled = Math.min(
    maxBurstMeters(rules),
    budget.meters + (rules.maxSpeed * rules.toleranceFactor * elapsed) / 1000,
  );

  if (!Number.isFinite(proposed.x) || !Number.isFinite(proposed.z)) {
    return { pos: { ...current }, budget: { meters: refilled, lastMs: nowMs }, corrected: true };
  }

  const dx = proposed.x - current.x;
  const dz = proposed.z - current.z;
  const dist = Math.hypot(dx, dz);

  let next: Vec2 = { x: proposed.x, z: proposed.z };
  let corrected = false;
  let travelled = dist;

  if (dist > refilled + EPSILON) {
    const k = refilled / dist;
    next = { x: current.x + dx * k, z: current.z + dz * k };
    travelled = refilled;
    corrected = true;
  }

  const bounded = clampToBounds(next, rules.bounds);
  if (bounded.x !== next.x || bounded.z !== next.z) corrected = true;

  return {
    pos: bounded,
    budget: { meters: Math.max(0, refilled - travelled), lastMs: nowMs },
    corrected,
  };
}
