import type { BankRules } from './schemas';

/**
 * Banque : commission et plafond de blanchiment. Pur, sans état.
 * Arrondi : la commission est arrondie à l'entier supérieur (la banque ne perd jamais un
 * dollar), le net crédité = montant − commission. Ex. fee 0.5 : 101 $ sales → 50 $ propres.
 * Plafond : somme sale blanchie sur une fenêtre glissante de `capWindowSeconds` (temps de jeu).
 */

/** Un blanchiment passé (temps de jeu en ms, montant sale). */
export interface LaunderEntry {
  at: number;
  amount: number;
}

export function launderSplit(amount: number, fee: number): { commission: number; net: number } {
  // epsilon : 0.3 × 100 = 30.000000000000004 ne doit pas devenir 31
  const commission = Math.min(amount, Math.max(0, Math.ceil(amount * fee - 1e-9)));
  return { commission, net: amount - commission };
}

const windowMs = (rules: Pick<BankRules, 'capWindowSeconds'>) => rules.capWindowSeconds * 1000;

/** Entrées encore dans la fenêtre glissante. */
export function activeEntries(
  log: readonly LaunderEntry[],
  now: number,
  rules: Pick<BankRules, 'capWindowSeconds'>,
): LaunderEntry[] {
  return log.filter((e) => now - e.at < windowMs(rules));
}

/** Somme encore blanchissable maintenant. */
export function launderRemaining(
  log: readonly LaunderEntry[],
  now: number,
  rules: Pick<BankRules, 'capWindowSeconds' | 'launderCap'>,
): number {
  const used = activeEntries(log, now, rules).reduce((s, e) => s + e.amount, 0);
  return Math.max(0, rules.launderCap - used);
}

/** Décale les entrées (temps passé sans joueur connecté : la fenêtre est gelée). */
export function shiftLog(log: readonly LaunderEntry[], deltaMs: number): LaunderEntry[] {
  return log.map((e) => ({ ...e, at: e.at + deltaMs }));
}

export interface LaunderRequest {
  hasAccount: boolean;
  /** Argent sale dans le sac. */
  dirty: number;
  amount: number;
  log: readonly LaunderEntry[];
  now: number;
}

export type LaunderCheck =
  | { ok: true; commission: number; net: number; log: LaunderEntry[] }
  | { ok: false; message: string };

/** Vérifie un blanchiment ; renvoie le partage et le nouveau journal (fenêtre purgée). */
export function checkLaunder(rules: BankRules, req: LaunderRequest): LaunderCheck {
  if (!req.hasAccount) return { ok: false, message: "Ouvrez d'abord un compte." };
  if (!Number.isInteger(req.amount) || req.amount <= 0)
    return { ok: false, message: 'Montant invalide.' };
  if (req.dirty <= 0) return { ok: false, message: "Vous n'avez pas d'argent sale sur vous." };
  if (req.amount > req.dirty)
    return { ok: false, message: `Vous n'avez que ${req.dirty} $ en espèces.` };
  const left = launderRemaining(req.log, req.now, rules);
  if (req.amount > left)
    return {
      ok: false,
      message:
        left > 0
          ? `Plafond atteint : encore ${left} $ possibles pour l'instant.`
          : 'Plafond atteint : revenez plus tard.',
    };
  const { commission, net } = launderSplit(req.amount, rules.fee);
  const log = [...activeEntries(req.log, req.now, rules), { at: req.now, amount: req.amount }];
  return { ok: true, commission, net, log };
}
