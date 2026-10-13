import { isBlocked, moveWithCollisions } from './collision';
import { clampToBounds, type Rect, type Vec2 } from './geometry';
import type { Bounds } from './schemas';

export interface MoveRules {
  /** Vitesse max autorisée (m/s), en pratique la vitesse de course. */
  maxSpeed: number;
  /** Marge pour la gigue réseau / l'imprécision du client (>= 1). */
  toleranceFactor: number;
  /** Plafond du crédit de déplacement accumulable (ms de course max d'un coup). */
  maxBurstMs: number;
  bounds: Bounds;
  /** Collisions (cercle joueur contre rectangles) ; absent = terrain vide. */
  collision?: { radius: number; obstacles: readonly Rect[] };
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
 * une position hors carte est ramenée dans les bornes ; une valeur non finie est refusée ;
 * avec `collision`, un trajet qui traverse ou finit dans un mur est arrêté contre ce mur.
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

  let final = clampToBounds(next, rules.bounds);
  if (final.x !== next.x || final.z !== next.z) corrected = true;

  if (rules.collision) {
    // Le trajet est rejoué contre les murs. Si la position proposée est libre et que le trajet
    // y arrive (à un rayon près : coins arrondis entre deux envois), on l'accepte telle quelle ;
    // sinon le mouvement traverse un mur ou finit dedans → position du trajet + correction.
    const { radius, obstacles } = rules.collision;
    const swept = moveWithCollisions(current, final, radius, obstacles, rules.bounds);
    const gap = Math.hypot(swept.x - final.x, swept.z - final.z);
    if (gap > radius || isBlocked(final, radius, obstacles)) {
      final = swept;
      corrected = true;
    }
  }

  return {
    pos: final,
    budget: { meters: Math.max(0, refilled - travelled), lastMs: nowMs },
    corrected,
  };
}
