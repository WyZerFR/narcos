import {
  cartTotal,
  checkout,
  formatSplit,
  gameData,
  splitCart,
  returnOne,
  takeFromShelf,
  type Cart,
  type ShelfStock,
  type Station,
} from '@narco/shared';
import type { ActionResult } from './lab';
import { CartLine, ShelfState, type GameState, type Player } from './schema';
import { readInventory, writeInventory } from './stateSync';

/**
 * Magasins côté serveur : étagères (stock réservé à la prise), panier par joueur, paiement
 * au comptoir. Les messages étant traités un par un, le dernier article ne part qu'une fois.
 */

const { shops, items } = gameData;

export const shelfKey = (interiorId: string, stationId: string) => `${interiorId}:${stationId}`;

const toStock = (s: ShelfState | undefined): ShelfStock => (!s || s.stock < 0 ? null : s.stock);

/**
 * Stock initial des étagères. `reset` : remet tout au stock de `shops.json` (nouvelle partie,
 * réapprovisionnement debug) ; sinon n'ajoute que les étagères manquantes (partie restaurée).
 */
export function stockShelves(state: GameState, reset = true): void {
  for (const shop of shops.values()) {
    for (const shelf of shop.shelves) {
      const key = shelfKey(shop.interiorId, shelf.stationId);
      const existing = state.shelves.get(key);
      if (existing && !reset) continue;
      const s = existing ?? new ShelfState();
      s.stock = shelf.stock ?? -1;
      if (!existing) state.shelves.set(key, s);
    }
  }
}

export function readCart(player: Player): Cart {
  return player.cart.map((l) => ({
    stationId: l.stationId,
    itemId: l.itemId,
    qty: l.qty,
    unitPrice: l.unitPrice,
    currency: l.currency === 'clean' || l.currency === 'any' ? l.currency : 'dirty',
  }));
}

const accountOf = (player: Player) => ({
  clean: player.cleanBalance,
  hasAccount: player.hasAccount,
});

/** Réécrit le panier, son total et sa répartition par monnaie (seul endroit où un prix est calculé). */
export function writeCart(player: Player, cart: Cart): void {
  player.cart.clear();
  for (const line of cart) player.cart.push(Object.assign(new CartLine(), line));
  player.cartTotal = cartTotal(cart);
  const split = splitCart(cart, accountOf(player));
  player.cartDirty = split.dirty;
  player.cartClean = split.clean;
}

function writeStock(state: GameState, key: string, stock: ShelfStock): void {
  const s = state.shelves.get(key);
  if (s) s.stock = stock ?? -1;
}

/** « Prendre » : 1 article de l'étagère passe dans le panier. */
export function takeItem(
  state: GameState,
  player: Player,
  interiorId: string,
  station: Station,
): ActionResult {
  const shelf = shops.get(interiorId)?.shelves.find((s) => s.stationId === station.id);
  if (!shelf) return { ok: false, text: 'Cette étagère est vide.' };
  const key = shelfKey(interiorId, station.id);
  const r = takeFromShelf(readCart(player), shelf, toStock(state.shelves.get(key)));
  if (!r.ok) return { ok: false, text: r.message };
  writeStock(state, key, r.value.stock);
  writeCart(player, r.value.cart);
  const name = items.get(shelf.itemId)?.name ?? shelf.itemId;
  return { ok: true, text: `${name} dans le panier (${shelf.price} $).` };
}

/** « Retirer » : repose 1 article en rayon. */
export function putBack(
  state: GameState,
  player: Player,
  interiorId: string,
  stationId: string,
): ActionResult {
  const r = returnOne(readCart(player), stationId);
  if (!r.ok) return { ok: false, text: r.message };
  const key = shelfKey(interiorId, stationId);
  const stock = toStock(state.shelves.get(key));
  if (stock !== null) writeStock(state, key, stock + 1);
  writeCart(player, r.value);
  return { ok: true, text: 'Article reposé en rayon.' };
}

/** Rend tout le panier au rayon (sortie du magasin, déconnexion, KO). */
export function returnCart(state: GameState, player: Player, interiorId: string): void {
  for (const line of readCart(player)) {
    const key = shelfKey(interiorId, line.stationId);
    const stock = toStock(state.shelves.get(key));
    if (stock !== null) writeStock(state, key, stock + line.qty);
  }
  writeCart(player, []);
}

/**
 * « Payer » au comptoir : espèces du sac et solde du compte débités selon la monnaie de chaque
 * article, achats rangés, tout ou rien.
 */
export function pay(player: Player, counter: Station): ActionResult {
  const r = checkout(readInventory(player.bag), readCart(player), accountOf(player), items);
  if (!r.ok) return { ok: false, text: r.message };
  writeInventory(player.bag, r.value.bag);
  player.cleanBalance = r.value.clean;
  writeCart(player, []);
  const vendor = counter.vendor ?? 'Le vendeur';
  return {
    ok: true,
    text: `${vendor} encaisse ${formatSplit(r.value.split)} sans poser de questions.`,
  };
}
