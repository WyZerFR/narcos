import type { GameData } from './data';
import { add, count, remove, type Inventory, type ItemLookup } from './inventory';
import { DIRTY_CASH } from './shop';
import type { Economy, NpcProfile, NpcsFile } from './schemas';
import { strainItem } from './production';

/**
 * Vente de rue (logique pure) : tirage de la demande d'un PNJ, prix, validation d'une vente.
 * Le hasard est injecté (`rng` ∈ [0, 1[) pour que les tests soient déterministes.
 */

export type Rng = () => number;

/** Ce qu'un PNJ veut acheter, tiré à son apparition (fixe jusqu'à sa prochaine réapparition). */
export interface Demand {
  profileId: string;
  interested: boolean;
  strainId: string;
  /** Pochons voulus. */
  qty: number;
  /** Argent sur lui ($). */
  budget: number;
  /** Prix unitaire proposé ($), fixe pour toute l'offre. */
  unitPrice: number;
  /** Durée d'attente devant une offre ouverte (ms de jeu). */
  patienceMs: number;
  /** Area du PNJ et multiplicateur de prix appliqué (`areas.json`). */
  area: string;
  priceMultiplier: number;
}

/** Ce qui change la vente selon l'area du PNJ : prix et proportion d'intéressés. */
export interface AreaMarket {
  id: string;
  priceMultiplier: number;
  demandRate: number;
}

/** Mention du bonus d'area affichée au joueur (« +25 % quartier »), ou null sans bonus. */
export function areaBonusLabel(priceMultiplier: number): string | null {
  const pct = Math.round((priceMultiplier - 1) * 100);
  if (pct === 0) return null;
  return pct > 0 ? `+${pct} % quartier` : `${pct} % quartier`;
}

const between = (rng: Rng, [min, max]: readonly [number, number]) => min + (max - min) * rng();
const intBetween = (rng: Rng, [min, max]: readonly [number, number]) =>
  Math.min(max, min + Math.floor((max - min + 1) * rng()));

/** Tirage pondéré d'un profil. */
export function pickProfile(profiles: readonly NpcProfile[], rng: Rng): NpcProfile {
  const total = profiles.reduce((s, p) => s + p.weight, 0);
  let r = rng() * total;
  for (const p of profiles) {
    r -= p.weight;
    if (r < 0) return p;
  }
  return profiles[profiles.length - 1]!;
}

/**
 * Prix unitaire d'un pochon : prix de la variété × (1 ± variation) × multiplicateur d'area,
 * arrondi au dollar le plus proche (une seule fois, à la fin), au moins 1 $.
 */
export function unitPriceFor(
  basePrice: number,
  rng: Rng,
  sale: Economy['sale'],
  priceMultiplier = 1,
): number {
  const k = 1 + (rng() * 2 - 1) * sale.priceVariance;
  return Math.max(1, Math.round(basePrice * k * priceMultiplier));
}

/**
 * Demande d'un PNJ selon son profil et son area (prix × `priceMultiplier`, chance d'être
 * intéressé × `demandRate`, plafonnée à 1). Le budget couvre toujours au moins un pochon.
 */
export function rollDemand(
  profile: NpcProfile,
  economy: Pick<Economy, 'strains' | 'sale'>,
  rng: Rng,
  /** Marché de l'area du PNJ (référence de prix 1.0 : `gameData.marketReference`). */
  market: AreaMarket,
): Demand {
  const strainId = profile.strains[Math.floor(rng() * profile.strains.length)]!;
  const strain = economy.strains.find((s) => s.id === strainId)!;
  const interested = rng() < Math.min(1, profile.interestChance * market.demandRate);
  const unitPrice = unitPriceFor(strain.pouchSellPrice, rng, economy.sale, market.priceMultiplier);
  const wanted = intBetween(rng, profile.qty);
  const budget = Math.max(unitPrice, Math.round(between(rng, profile.budget)));
  return {
    profileId: profile.id,
    interested,
    strainId,
    qty: Math.max(1, Math.min(wanted, Math.floor(budget / unitPrice))),
    budget,
    unitPrice,
    patienceMs: between(rng, profile.patienceSeconds) * 1000,
    area: market.id,
    priceMultiplier: market.priceMultiplier,
  };
}

/** Prénom au hasard, en évitant ceux déjà pris si possible. */
export function pickName(names: NpcsFile['names'], taken: ReadonlySet<string>, rng: Rng): string {
  const free = names.filter((n) => !taken.has(n));
  const pool = free.length > 0 ? free : names;
  return pool[Math.floor(rng() * pool.length)]!;
}

export type SaleOutcome =
  { ok: true; bag: Inventory; amount: number; pouchId: string } | { ok: false; message: string };

/**
 * Vente de `qty` pochons à un PNJ : tout ou rien. Les pochons quittent le sac, l'argent sale y
 * entre ; refus clair si la quantité est hors offre, s'il manque des pochons ou de la place.
 */
export function sellPouches(
  bag: Inventory,
  demand: Demand,
  qty: number,
  data: Pick<GameData, 'items'>,
  /** Refus si l'argent ne tient pas (poches ou sac, voir `bagFullText`). */
  fullMessage = "Sac plein : pas de place pour l'argent.",
): SaleOutcome {
  const items: ItemLookup = data.items;
  if (!demand.interested) return { ok: false, message: 'Pas intéressé.' };
  if (!Number.isInteger(qty) || qty < 1 || qty > demand.qty)
    return { ok: false, message: `Il en veut entre 1 et ${demand.qty}.` };
  const pouch = strainItem(items, 'pouch', demand.strainId);
  if (!pouch) return { ok: false, message: 'Pochon inconnu.' };
  if (count(bag, pouch.id) < qty) return { ok: false, message: `Pas assez de ${pouch.name}.` };
  const amount = qty * demand.unitPrice;
  const without = remove(bag, pouch.id, qty, items);
  if (!without.ok) return { ok: false, message: without.message };
  const paid = add(without.inv, DIRTY_CASH, amount, items);
  if (!paid.ok) return { ok: false, message: fullMessage };
  return { ok: true, bag: paid.inv, amount, pouchId: pouch.id };
}

/** Profil le plus acheteur (acheteur de debug). */
export function buyerProfile(profiles: readonly NpcProfile[]): NpcProfile {
  return profiles.reduce((best, p) => (p.interestChance > best.interestChance ? p : best));
}
