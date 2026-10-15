import { count, remove, type Inventory, type ItemLookup } from './inventory';
import type { Outcome } from './production';
import type { Economy } from './schemas';

/**
 * Capacité du sac (pur) : poches au départ (`bagTier` 0), sac à dos équipé (`bagTier` 1).
 * La taille réelle du sac d'un joueur est celle de son tableau de cases (serveur) ; ces
 * fonctions décident quand elle change, sans jamais perdre un objet.
 */

export type BagRules = Economy['bag'];

/** Nombre de cases pour un palier : 0 = poches, 1 = sac à dos. */
export function bagCapacity(rules: BagRules, tier: number): number {
  return tier >= 1 ? rules.backpackSlots : rules.pocketSlots;
}

/**
 * Refus quand il n'y a plus de place, seule source de ce texte : « Poches pleines » sans sac à
 * dos, « Sac plein » avec ; `detail` précise l'action refusée (sinon conseil par défaut).
 */
export function bagFullText(tier: number, detail?: string): string {
  const head = tier >= 1 ? 'Sac plein' : 'Poches pleines';
  return `${head} : ${detail ?? (tier >= 1 ? 'fais de la place.' : 'libère une case.')}`;
}

/**
 * Palier d'une sauvegarde : celui enregistré, sinon (ancienne partie à 10 cases) poches si ses
 * objets y tiennent, sac à dos sinon (aucun objet n'est supprimé).
 */
export function bagTierFor(rules: BagRules, saved: number | undefined, inv: Inventory): number {
  if (saved !== undefined) return saved;
  return inv.filter(Boolean).length > rules.pocketSlots ? 1 : 0;
}

/**
 * Ramène un sac à `capacity` cases sans rien perdre : cases vides en plus ajoutées ; si le sac
 * est plus long, ses piles sont tassées en tête (ordre conservé) et il garde au moins autant de
 * cases que de piles.
 */
export function fitBag(inv: Inventory, capacity: number): Inventory {
  if (inv.length === capacity) return inv;
  if (inv.length < capacity) return [...inv, ...Array<null>(capacity - inv.length).fill(null)];
  const stacks = inv.filter(Boolean);
  const size = Math.max(capacity, stacks.length);
  return [...stacks, ...Array<null>(size - stacks.length).fill(null)];
}

/**
 * Équiper le sac à dos : l'objet quitte le sac (il est porté, plus jamais déposable ni
 * vendable), le palier passe à 1 et le sac s'agrandit. Refusé si un sac est déjà porté.
 */
export function equipBackpack(
  inv: Inventory,
  tier: number,
  rules: BagRules,
  items: ItemLookup,
): Outcome<{ bag: Inventory; tier: number }> {
  if (tier >= 1) return { ok: false, message: 'Tu portes déjà un sac.' };
  if (count(inv, rules.backpackItemId) < 1)
    return { ok: false, message: "Tu n'as pas de sac à dos." };
  const r = remove(inv, rules.backpackItemId, 1, items);
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, value: { bag: fitBag(r.inv, bagCapacity(rules, 1)), tier: 1 } };
}
