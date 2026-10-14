import type { ItemDef, SurvivalRules, Vitals } from './schemas';

/**
 * Survie (faim, soif, santé) en fonctions pures. Le serveur appelle `decayVitals` avec le temps
 * écoulé depuis la dernière mise à jour (`survivalAt`), uniquement pour les joueurs connectés.
 */

/**
 * Fait baisser les jauges sur `elapsedMs`. La santé ne baisse que pendant le temps passé avec
 * la faim ou la soif à 0 (calcul par morceaux : peu importe la fréquence des appels).
 */
export function decayVitals(
  vitals: Vitals,
  elapsedMs: number,
  rules: SurvivalRules,
): { vitals: Vitals; ko: boolean } {
  const minutes = Math.max(0, elapsedMs) / 60_000;
  const untilZero = (value: number, rate: number) => (rate > 0 ? value / rate : Infinity);
  const zeroAfter = Math.min(
    untilZero(vitals.hunger, rules.hungerPerMinute),
    untilZero(vitals.thirst, rules.thirstPerMinute),
  );
  const starving = Math.max(0, minutes - zeroAfter);
  const next: Vitals = {
    hunger: Math.max(0, vitals.hunger - rules.hungerPerMinute * minutes),
    thirst: Math.max(0, vitals.thirst - rules.thirstPerMinute * minutes),
    health: Math.max(0, vitals.health - rules.healthLossPerMinuteAtZero * starving),
  };
  return { vitals: next, ko: next.health <= 0 };
}

/** Sous le seuil bas : vitesse réduite, jauge qui clignote. */
export function isLow(vitals: Vitals, rules: SurvivalRules): boolean {
  return vitals.hunger < rules.lowThreshold || vitals.thirst < rules.lowThreshold;
}

export function speedFactor(vitals: Vitals, rules: SurvivalRules): number {
  return isLow(vitals, rules) ? rules.lowSpeedFactor : 1;
}

/** Mange ou boit : restauration plafonnée au maximum. */
export function consume(vitals: Vitals, item: ItemDef, rules: SurvivalRules): Vitals | null {
  const r = item.restores;
  if (!r || (!r.hunger && !r.thirst)) return null;
  return {
    hunger: Math.min(rules.max, vitals.hunger + (r.hunger ?? 0)),
    thirst: Math.min(rules.max, vitals.thirst + (r.thirst ?? 0)),
    health: vitals.health,
  };
}

/** Argent sale perdu au KO (arrondi à l'unité inférieure). */
export function koCashLoss(cash: number, rules: SurvivalRules): number {
  return Math.floor((cash * rules.koDirtyCashLossPercent) / 100);
}
