import { add, count, remove, type Inventory, type ItemLookup } from './inventory';
import type { Outcome } from './production';
import type { Currency, Shelf } from './schemas';

/**
 * Magasins : panier et paiement, en fonctions pures. Le serveur est seul à les appeler avec
 * les prix de `shops.json` ; le client ne fait qu'afficher ce que le serveur a calculé.
 * « Prendre » réserve l'article (le stock de l'étagère baisse aussitôt), le paiement débite
 * chaque monnaie (espèces sales du sac, solde propre du compte) et range les achats, tout ou rien.
 */

/** Objet servant de monnaie dans les magasins. */
export const DIRTY_CASH = 'cash_dirty';

export interface CartLine {
  stationId: string;
  itemId: string;
  qty: number;
  unitPrice: number;
  currency: Currency;
}

export type Cart = readonly CartLine[];

/** `null` = stock illimité. */
export type ShelfStock = number | null;

const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const no = <T>(message: string): Outcome<T> => ({ ok: false, message });

export function cartTotal(cart: Cart): number {
  return cart.reduce((sum, l) => sum + l.qty * l.unitPrice, 0);
}

export function cartCount(cart: Cart): number {
  return cart.reduce((n, l) => n + l.qty, 0);
}

/** Prend 1 article sur une étagère : il passe dans le panier et quitte le rayon. */
export function takeFromShelf(
  cart: Cart,
  shelf: Shelf,
  stock: ShelfStock,
): Outcome<{ cart: CartLine[]; stock: ShelfStock }> {
  if (stock !== null && stock <= 0) return no('Rupture de stock.');
  const existing = cart.find((l) => l.stationId === shelf.stationId);
  const next = existing
    ? cart.map((l) => (l === existing ? { ...l, qty: l.qty + 1 } : l))
    : [
        ...cart,
        {
          stationId: shelf.stationId,
          itemId: shelf.itemId,
          qty: 1,
          unitPrice: shelf.price,
          currency: shelf.currency,
        },
      ];
  return ok({ cart: next, stock: stock === null ? null : stock - 1 });
}

/** Repose 1 article d'une ligne du panier (la ligne disparaît à 0). */
export function returnOne(cart: Cart, stationId: string): Outcome<CartLine[]> {
  const line = cart.find((l) => l.stationId === stationId);
  if (!line) return no("Cet article n'est pas dans ton panier.");
  return ok(
    line.qty > 1
      ? cart.map((l) => (l === line ? { ...l, qty: l.qty - 1 } : l))
      : cart.filter((l) => l !== line),
  );
}

/** Ce que le joueur peut dépenser : solde propre et compte (les espèces sont dans le sac). */
export interface Account {
  clean: number;
  hasAccount: boolean;
}

/** Montant à payer dans chaque monnaie. */
export interface CartSplit {
  dirty: number;
  clean: number;
}

/**
 * Répartit le panier entre les deux monnaies. Les articles « any » passent sur le compte s'il
 * est ouvert et couvre leur total en plus des articles « clean », sinon en espèces.
 */
export function splitCart(cart: Cart, account: Account): CartSplit {
  const sum = (c: Currency) =>
    cart.reduce((s, l) => s + (l.currency === c ? l.qty * l.unitPrice : 0), 0);
  const dirty = sum('dirty');
  const clean = sum('clean');
  const any = sum('any');
  return account.hasAccount && clean + any <= account.clean
    ? { dirty, clean: clean + any }
    : { dirty: dirty + any, clean };
}

/** « 70 $ en espèces + 12 $ par carte » (montants non nuls seulement). */
export function formatSplit(split: CartSplit): string {
  const parts = [
    split.dirty > 0 ? `${split.dirty} $ en espèces` : '',
    split.clean > 0 ? `${split.clean} $ par carte` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' + ') : '0 $';
}

export interface Paid {
  bag: Inventory;
  /** Solde propre après paiement. */
  clean: number;
  split: CartSplit;
}

/**
 * Paiement : compte, argent propre, argent sale, puis place dans le sac ; tout ou rien
 * (un refus ne débite rien). Renvoie le sac et le solde après achat.
 */
export function checkout(
  bag: Inventory,
  cart: Cart,
  account: Account,
  items: ItemLookup,
): Outcome<Paid> {
  if (cart.length === 0) return no('Ton panier est vide.');
  const split = splitCart(cart, account);
  if (split.clean > 0 && !account.hasAccount) return no("Ouvre d'abord un compte.");
  if (split.clean > account.clean)
    return no(`Pas assez d'argent propre (${account.clean} $ sur ${split.clean} $).`);
  const cash = count(bag, DIRTY_CASH);
  if (cash < split.dirty) return no(`Pas assez d'argent sale (${cash} $ sur ${split.dirty} $).`);
  let next: Inventory = bag;
  if (split.dirty > 0) {
    const paid = remove(next, DIRTY_CASH, split.dirty, items);
    if (!paid.ok) return no(paid.message);
    next = paid.inv;
  }
  for (const line of cart) {
    const added = add(next, line.itemId, line.qty, items);
    if (!added.ok) return no('Sac plein : fais de la place avant de payer.');
    next = added.inv;
  }
  return ok({ bag: next, clean: account.clean - split.clean, split });
}
