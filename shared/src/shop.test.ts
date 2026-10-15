import { describe, expect, it } from 'vitest';
import { gameData } from './data';
import { add, count, emptyInventory, type Inventory } from './inventory';
import {
  cartCount,
  cartTotal,
  checkout,
  formatSplit,
  returnOne,
  splitCart,
  takeFromShelf,
  type Account,
  type CartLine,
} from './shop';

const items = gameData.items;
const shelves = gameData.shops.get('shop')!.shelves;
const seeds = shelves.find((s) => s.itemId === 'seed_base')!;
const pots = shelves.find((s) => s.itemId === 'pot')!;
const tools = shelves.find((s) => s.currency === 'clean')!;
const grocery = gameData.shops.get('grocery')!.shelves;
const food = grocery.find((s) => s.itemId === 'food')!;
const water = grocery.find((s) => s.itemId === 'water')!;
const NO_ACCOUNT: Account = { clean: 0, hasAccount: false };

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
    const r = checkout(bagWith(100), cart, NO_ACCOUNT, items);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(count(r.value.bag, 'cash_dirty')).toBe(100 - seeds.price - pots.price);
      expect(count(r.value.bag, 'seed_base')).toBe(1);
      expect(count(r.value.bag, 'pot')).toBe(1);
      expect(r.value.clean).toBe(0);
    }
  });

  it('refuse sans assez d’argent sale', () => {
    const cart = take([], pots, null).cart;
    const r = checkout(bagWith(pots.price - 1), cart, NO_ACCOUNT, items);
    expect(!r.ok && r.message).toMatch(/Pas assez d'argent sale/);
  });

  it('refuse si le sac est plein, sans rien débiter', () => {
    let bag = bagWith(500, 2);
    const filled = add(bag, 'scissors', 1, items);
    if (filled.ok) bag = filled.inv;
    const cart = take([], seeds, null).cart;
    const r = checkout(bag, cart, NO_ACCOUNT, items);
    expect(!r.ok && r.message).toMatch(/Sac plein/);
  });

  it('refuse un panier vide', () => {
    expect(checkout(bagWith(10), [], NO_ACCOUNT, items).ok).toBe(false);
  });
});

describe('deux monnaies', () => {
  it('chaque étagère porte sa monnaie : matériel au sale, outils au propre, nourriture « any »', () => {
    expect(seeds.currency).toBe('dirty');
    expect(pots.currency).toBe('dirty');
    expect(tools.currency).toBe('clean');
    expect(food.currency).toBe('any');
    expect(water.currency).toBe('any');
    expect(take([], tools, null).cart[0]!.currency).toBe('clean');
  });

  it('nourriture « any » payée en espèces sans compte', () => {
    const cart = take([], food, null).cart;
    expect(splitCart(cart, NO_ACCOUNT)).toEqual({ dirty: food.price, clean: 0 });
    const r = checkout(bagWith(50), cart, NO_ACCOUNT, items);
    expect(r.ok && count(r.value.bag, 'cash_dirty')).toBe(50 - food.price);
  });

  it('nourriture « any » payée en propre si le solde couvre, en espèces sinon', () => {
    const cart = take(take([], food, null).cart, water, null).cart;
    const total = food.price + water.price;
    const rich = { clean: total, hasAccount: true };
    expect(splitCart(cart, rich)).toEqual({ dirty: 0, clean: total });
    const r = checkout(bagWith(50), cart, rich, items);
    expect(r.ok && r.value.clean).toBe(0);
    expect(r.ok && count(r.value.bag, 'cash_dirty')).toBe(50);
    expect(splitCart(cart, { clean: total - 1, hasAccount: true })).toEqual({
      dirty: total,
      clean: 0,
    });
  });

  it('graines toujours au sale, même avec un compte bien rempli', () => {
    const cart = take([], seeds, null).cart;
    expect(splitCart(cart, { clean: 1000, hasAccount: true })).toEqual({
      dirty: seeds.price,
      clean: 0,
    });
  });

  it('article « clean » refusé sans compte, puis sans solde', () => {
    const cart = take([], tools, null).cart;
    const r = checkout(bagWith(500), cart, NO_ACCOUNT, items);
    expect(!r.ok && r.message).toBe("Ouvre d'abord un compte.");
    const poor = checkout(bagWith(500), cart, { clean: tools.price - 1, hasAccount: true }, items);
    expect(!poor.ok && poor.message).toMatch(/Pas assez d'argent propre/);
  });

  it('panier mixte atomique : un refus ne débite aucune monnaie', () => {
    const cart = take(take(take([], seeds, null).cart, tools, null).cart, food, null).cart;
    const account = { clean: tools.price, hasAccount: true };
    // propre : outils seulement (la nourriture ne tient pas en plus) ; sale : graines + nourriture
    expect(splitCart(cart, account)).toEqual({
      dirty: seeds.price + food.price,
      clean: tools.price,
    });
    const short = checkout(bagWith(seeds.price), cart, account, items);
    expect(!short.ok && short.message).toMatch(/Pas assez d'argent sale/);
    const r = checkout(bagWith(100), cart, account, items);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.clean).toBe(0);
      expect(count(r.value.bag, 'cash_dirty')).toBe(100 - seeds.price - food.price);
      expect(count(r.value.bag, 'scissors')).toBe(1);
    }
    expect(formatSplit({ dirty: 12, clean: 20 })).toBe('12 $ en espèces + 20 $ par carte');
  });
});

describe('départ', () => {
  it('150 $ sales couvrent le kit minimal et au moins 3 articles de nourriture ou boisson', () => {
    const { economy } = gameData;
    expect(economy.startingMoney).toEqual({ dirty: 150, clean: 0 });
    const kit = ['pot', 'drying_rack', 'cutting_table'].map((id) =>
      shelves.find((s) => s.itemId === id)!,
    );
    let cart: CartLine[] = [];
    for (const shelf of kit) cart = take(cart, shelf, null).cart;
    const cheapest = Math.min(...grocery.filter((s) => s.currency === 'any').map((s) => s.price));
    expect(cartTotal(cart) + 3 * cheapest).toBeLessThanOrEqual(economy.startingMoney.dirty);
    expect(kit.every((s) => s.currency === 'dirty')).toBe(true);
  });
});
