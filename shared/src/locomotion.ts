import type { GameConfig } from './schemas';
import { angleDelta, smoothFactor } from './smoothing';

/**
 * Locomotion d'un personnage affiché (pure, sans three) : vitesse mesurée et lissée, allure
 * avec hystérésis, poids de fondu des clips, `timeScale` proportionnel à la vitesse, cap lissé
 * par le chemin le plus court, penchement et balancement de repli. Même résultat à 30 et 60 fps.
 */

export type Gait = 'idle' | 'walk' | 'run';
export type GaitWeights = Record<Gait, number>;
export type LocomotionRules = GameConfig['characters']['locomotion'];

const GAITS: readonly Gait[] = ['idle', 'walk', 'run'];

/** Allures disponibles (clips trouvés) : sans course, la marche couvre tout. */
export interface GaitClips {
  walk: boolean;
  run: boolean;
}

/**
 * Allure pour une vitesse (m/s) : on n'en change qu'en franchissant le seuil de départ dans un
 * sens et celui d'arrêt dans l'autre, pour ne pas clignoter autour d'une valeur.
 */
export function nextGait(current: Gait, speed: number, r: LocomotionRules, clips: GaitClips): Gait {
  const moving = current === 'idle' ? speed > r.walkStart : speed >= r.walkStop;
  if (!moving) return 'idle';
  if (!clips.run) return 'walk';
  const running = current === 'run' ? speed >= r.runStop : speed > r.runStart;
  return running ? 'run' : 'walk';
}

/** Vitesse de lecture d'un clip : vitesse réelle / vitesse naturelle du clip, bornée. */
export function gaitTimeScale(gait: Gait, speed: number, r: LocomotionRules): number {
  if (gait === 'idle') return 1;
  const natural = gait === 'run' ? r.runClipSpeed : r.walkClipSpeed;
  return Math.min(r.timeScale.max, Math.max(r.timeScale.min, speed / natural));
}

/**
 * Fondu enchaîné : chaque poids va linéairement vers 1 (allure visée) ou 0 en `fade` secondes.
 * Repart des poids courants si la cible change en plein fondu : aucun saut de pose.
 */
export function stepWeights(w: GaitWeights, target: Gait, dt: number, fade: number): GaitWeights {
  const step = fade > 0 ? dt / fade : 1;
  const out = { ...w };
  for (const g of GAITS) {
    const goal = g === target ? 1 : 0;
    const v = w[g];
    out[g] = v < goal ? Math.min(goal, v + step) : Math.max(goal, v - step);
  }
  // la somme reste 1 (les poids partent d'une somme 1 et bougent au même pas)
  const sum = out.idle + out.walk + out.run;
  if (sum > 0) for (const g of GAITS) out[g] /= sum;
  return out;
}

/** Cap lissé vers `target` par le chemin le plus court, indépendant du pas de temps. */
export function turnToward(current: number, target: number, dt: number, stiffness: number): number {
  const a = current + angleDelta(current, target) * smoothFactor(stiffness, dt);
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export class Locomotion {
  speed = 0;
  gait: Gait = 'idle';
  weights: GaitWeights = { idle: 1, walk: 0, run: 0 };
  heading: number;
  lean = 0;
  /** Phase du balancement de repli (rad), avancée par la distance parcourue. */
  bobPhase = 0;
  clips: GaitClips = { walk: true, run: true };
  private last: { x: number; z: number } | null = null;

  constructor(
    private readonly rules: LocomotionRules,
    heading = 0,
  ) {
    this.heading = heading;
  }

  /**
   * Une frame : `x, z` = position affichée (interpolée pour les autres joueurs), `targetHeading`
   * = cap voulu (rad). Sans mouvement, le cap ne bouge pas.
   */
  step(x: number, z: number, targetHeading: number, dt: number): void {
    if (dt <= 0) return;
    const r = this.rules;
    const prev = this.last;
    this.last = { x, z };
    let measured = prev ? Math.hypot(x - prev.x, z - prev.z) / dt : 0;
    if (measured > r.teleportSpeed) measured = 0; // changement de zone, recalage : pas une course
    this.speed += (measured - this.speed) * smoothFactor(r.speedSmoothing, dt);
    this.gait = nextGait(this.gait, this.speed, r, this.clips);
    this.weights = stepWeights(this.weights, this.gait, dt, r.crossFadeSeconds);
    if (this.speed > r.turnMinSpeed)
      this.heading = turnToward(this.heading, targetHeading, dt, r.turnStiffness);
    const leanGoal = Math.min(r.lean.max, this.speed * r.lean.perSpeed);
    this.lean += (leanGoal - this.lean) * smoothFactor(r.lean.stiffness, dt);
    if (this.gait !== 'idle') this.bobPhase += this.speed * dt * r.bob.stridesPerMeter * Math.PI;
  }

  timeScale(gait: Gait): number {
    return gaitTimeScale(gait, this.speed, this.rules);
  }

  /** Rebond vertical (m) quand aucun clip de marche n'existe ; 0 sinon ou à l'arrêt. */
  bobOffset(): number {
    if (this.clips.walk || this.gait === 'idle') return 0;
    return Math.abs(Math.sin(this.bobPhase)) * this.rules.bob.height;
  }
}
