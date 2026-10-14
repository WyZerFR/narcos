import { describe, expect, it } from 'vitest';
import { gameData } from './data';
import { add, count, emptyInventory, type Inventory } from './inventory';
import { cartCount, cartTotal, checkout, returnOne, takeFromShelf, type CartLine } from './shop';

const items = gameData.items;
const shelves = gameData.shops.get('shop')!.shelves;
const seeds = shelves.find((s) => s.itemId === 'seed_base')!;
const pots = shelves.find((s) => s.itemId === 'pot')!;

function bagWith(cash: number, slots = 10): Inventory {
  const r = add(emptyInventory(slots), 'cash_dirty', cash, items);
  if (!r.ok) throw new Error(r.message);
  return r.inv;
}

function take(cart: CartLine[], shelf: typeof seeds, stock: number | null) {
  const r = takeFromShelf(cart, shelf, stock);
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

describe('panier', () => {
  it('cumule les articles d’une même étagère et calcule le total', () => {
    let cart: CartLine[] = [];
    cart = take(cart, seeds, 10).cart;
    cart = take(cart, seeds, 9).cart;
    cart = take(cart, pots, 3).cart;
    expect(cart).toHaveLength(2);
    expect(cartCount(cart)).toBe(3);
    expect(cartTotal(cart)).toBe(2 * seeds.price + pots.price);
  });

  it('réserve l’article : le stock baisse, et refuse quand le rayon est vide', () => {
    const r = take([], pots, 1);
    expect(r.stock).toBe(0);
    expect(takeFromShelf(r.cart, pots, r.stock)).toMatchObject({ ok: false });
    expect(take([], seeds, null).stock).toBeNull();
  });

  it('repose un article à la fois', () => {
    let cart = take(take([], seeds, null).cart, seeds, null).cart;
    const back = returnOne(cart, seeds.stationId);
    expect(back.ok && back.value[0]!.qty).toBe(1);
    cart = back.ok ? back.value : cart;
    const empty = returnOne(cart, seeds.stationId);
    expect(empty.ok && empty.value).toEqual([]);
    expect(returnOne([], seeds.stationId).ok).toBe(false);
  });
});

describe('paiement', () => {
  it('débite l’argent sale et range les achats', () => {
    const cart = take(take([], seeds, null).cart, pots, null).cart;
    const r = checkout(bagWith(100), cart, items);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(count(r.value, 'cash_dirty')).toBe(100 - seeds.price - pots.price);
      expect(count(r.value, 'seed_base')).toBe(1);
      expect(count(r.value, 'pot')).toBe(1);
    }
  });

  it('refuse sans assez d’argent', () => {
    const cart = take([], pots, null).cart;
    const r = checkout(bagWith(pots.price - 1), cart, items);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.message).toMatch(/Pas assez d'argent/);
  });

  it('refuse si le sac est plein, sans rien débiter', () => {
    let bag = bagWith(500, 2);
    const filled = add(bag, 'scissors', 1, items);
    if (filled.ok) bag = filled.inv;
    const cart = take([], seeds, null).cart;
    const r = checkout(bag, cart, items);
    expect(!r.ok && r.message).toMatch(/Sac plein/);
  });

  it('refuse un panier vide', () => {
    expect(checkout(bagWith(10), [], items).ok).toBe(false);
  });
});
