import { add, count, remove, type Inventory, type ItemLookup } from './inventory';
import type { Outcome } from './production';
import type { Shelf } from './schemas';

/**
 * Magasins : panier et paiement, en fonctions pures. Le serveur est seul à les appeler avec
 * les prix de `shops.json` ; le client ne fait qu'afficher ce que le serveur a calculé.
 * « Prendre » réserve l'article (le stock de l'étagère baisse aussitôt), le paiement débite
 * l'argent sale du sac et y range les achats, tout ou rien.
 */

/** Objet servant de monnaie dans les magasins. */
export const DIRTY_CASH = 'cash_dirty';

export interface CartLine {
  stationId: string;
  itemId: string;
  qty: number;
  unitPrice: number;
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
        { stationId: shelf.stationId, itemId: shelf.itemId, qty: 1, unitPrice: shelf.price },
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

/**
 * Paiement : vérifie l'argent sale puis la place dans le sac, tout ou rien.
 * Renvoie le sac après achat.
 */
export function checkout(bag: Inventory, cart: Cart, items: ItemLookup): Outcome<Inventory> {
  if (cart.length === 0) return no('Ton panier est vide.');
  const total = cartTotal(cart);
  const cash = count(bag, DIRTY_CASH);
  if (cash < total) return no(`Pas assez d'argent (${cash} $ sur ${total} $).`);
  let next: Inventory = bag;
  if (total > 0) {
    const paid = remove(next, DIRTY_CASH, total, items);
    if (!paid.ok) return no(paid.message);
    next = paid.inv;
  }
  for (const line of cart) {
    const added = add(next, line.itemId, line.qty, items);
    if (!added.ok) return no('Sac plein : fais de la place avant de payer.');
    next = added.inv;
  }
  return ok(next);
}
