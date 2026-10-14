import { describe, expect, it } from 'vitest';
import { gameData } from './data';
import {
  add,
  capacityFor,
  count,
  emptyInventory,
  moveStack,
  remove,
  transfer,
  type Inventory,
} from './inventory';

const items = gameData.items;
const seedMax = items.get('seed_base')!.stackMax; // 20
const waterMax = items.get('water')!.stackMax; // 5

function must(r: ReturnType<typeof add>): Inventory {
  if (!r.ok) throw new Error(r.message);
  return r.inv;
}

describe('inventaire — ajout et piles', () => {
  it('empile dans une pile existante avant d’ouvrir un slot', () => {
    let inv = must(add(emptyInventory(3), 'seed_base', 5, items));
    inv = must(add(inv, 'seed_base', 4, items));
    expect(inv).toEqual([{ itemId: 'seed_base', qty: 9 }, null, null]);
  });

  it('respecte la limite de pile et déborde sur un nouveau slot', () => {
    const inv = must(add(emptyInventory(3), 'water', waterMax + 2, items));
    expect(inv).toEqual([{ itemId: 'water', qty: waterMax }, { itemId: 'water', qty: 2 }, null]);
  });

  it('refuse en bloc quand il n’y a pas la place (aucun ajout partiel)', () => {
    const inv = must(add(emptyInventory(1), 'water', waterMax - 1, items));
    const r = add(inv, 'water', 2, items);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('full');
    expect(capacityFor(inv, 'water', items)).toBe(1);
  });

  it('refuse un slot plein d’un autre objet', () => {
    const inv = must(add(emptyInventory(1), 'seed_base', 1, items));
    const r = add(inv, 'water', 1, items);
    expect(r.ok).toBe(false);
  });

  it('refuse un objet inconnu, un objet non rangeable et une quantité invalide', () => {
    const inv = emptyInventory(2);
    expect(add(inv, 'caviar', 1, items)).toMatchObject({ ok: false, error: 'unknown_item' });
    expect(add(inv, 'cash_clean', 1, items)).toMatchObject({ ok: false, error: 'not_storable' });
    expect(add(inv, 'water', 0, items)).toMatchObject({ ok: false, error: 'bad_qty' });
    expect(add(inv, 'water', 1.5, items)).toMatchObject({ ok: false, error: 'bad_qty' });
  });

  it('ne modifie jamais l’inventaire d’origine', () => {
    const inv = must(add(emptyInventory(2), 'seed_base', 3, items));
    const snapshot = JSON.stringify(inv);
    add(inv, 'seed_base', 3, items);
    remove(inv, 'seed_base', 2, items);
    expect(JSON.stringify(inv)).toBe(snapshot);
  });
});

describe('inventaire — retrait', () => {
  it('retire sur plusieurs piles et libère les slots vidés', () => {
    let inv = must(add(emptyInventory(3), 'seed_base', seedMax + 3, items));
    inv = must(remove(inv, 'seed_base', 5, items));
    expect(count(inv, 'seed_base')).toBe(seedMax - 2);
    expect(inv.filter(Boolean)).toHaveLength(1);
  });

  it('refuse une quantité insuffisante', () => {
    const inv = must(add(emptyInventory(2), 'water', 2, items));
    const r = remove(inv, 'water', 3, items);
    expect(r).toMatchObject({ ok: false, error: 'insufficient' });
  });
});

describe('inventaire — transferts sac ↔ stock', () => {
  it('transfère une partie d’une pile', () => {
    const bag = must(add(emptyInventory(2), 'seed_base', 6, items));
    const r = transfer(bag, 0, emptyInventory(4), 4, items);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.from[0]).toEqual({ itemId: 'seed_base', qty: 2 });
      expect(count(r.to, 'seed_base')).toBe(4);
    }
  });

  it('transfère toute la pile et vide le slot', () => {
    const bag = must(add(emptyInventory(2), 'water', 3, items));
    const stock = must(add(emptyInventory(2), 'water', 1, items));
    const r = transfer(bag, 0, stock, 3, items);
    expect(r.ok && r.from[0]).toBe(null);
    expect(r.ok && r.to[0]).toEqual({ itemId: 'water', qty: 4 });
  });

  it('refuse si la destination est pleine, sans rien perdre', () => {
    const bag = must(add(emptyInventory(1), 'water', 3, items));
    const stock = must(add(emptyInventory(1), 'seed_base', 1, items));
    const r = transfer(bag, 0, stock, 3, items);
    expect(r).toMatchObject({ ok: false, error: 'full' });
  });

  it('refuse un slot vide ou une quantité supérieure à la pile', () => {
    const bag = must(add(emptyInventory(2), 'water', 2, items));
    expect(transfer(bag, 1, emptyInventory(2), 1, items)).toMatchObject({ error: 'empty_slot' });
    expect(transfer(bag, 0, emptyInventory(2), 3, items)).toMatchObject({ error: 'insufficient' });
  });
});

describe('inventaire — glisser-déposer (moveStack)', () => {
  const inv = (...stacks: ([string, number] | null)[]): Inventory =>
    stacks.map((s) => (s ? { itemId: s[0], qty: s[1] } : null));

  it('déplace une pile vers un slot vide du même inventaire', () => {
    const r = moveStack(inv(['water', 3], null, null), 0, null, 2, items);
    expect(r.ok && r.from).toEqual(inv(null, null, ['water', 3]));
  });

  it('fusionne deux piles du même objet, le surplus reste à la source', () => {
    const r = moveStack(inv(['water', 4], ['water', waterMax - 1]), 0, null, 1, items);
    expect(r.ok && r.from).toEqual(inv(['water', 3], ['water', waterMax]));
    const full = moveStack(inv(['water', 1], ['water', waterMax]), 0, null, 1, items);
    expect(full).toMatchObject({ ok: false, error: 'full' });
  });

  it('échange deux objets différents', () => {
    const r = moveStack(inv(['water', 2], ['seed_base', 5]), 0, null, 1, items);
    expect(r.ok && r.from).toEqual(inv(['seed_base', 5], ['water', 2]));
  });

  it('passe d\x27un inventaire à l\x27autre (sac → stock), fusion et échange compris', () => {
    const bag = inv(['seed_base', 3], ['water', 1]);
    const stock = inv(['seed_base', seedMax - 1], ['food', 2]);
    const merged = moveStack(bag, 0, stock, 0, items);
    expect(merged.ok && merged.from[0]).toEqual({ itemId: 'seed_base', qty: 2 });
    expect(merged.ok && merged.to[0]).toEqual({ itemId: 'seed_base', qty: seedMax });
    const swapped = moveStack(bag, 1, stock, 1, items);
    expect(swapped.ok && swapped.from[1]).toEqual({ itemId: 'food', qty: 2 });
    expect(swapped.ok && swapped.to[1]).toEqual({ itemId: 'water', qty: 1 });
  });

  it('refuse un slot vide ou hors limites, et ne modifie jamais l\x27original', () => {
    const bag = inv(['water', 2], null);
    const snapshot = JSON.stringify(bag);
    expect(moveStack(bag, 1, null, 0, items)).toMatchObject({ error: 'empty_slot' });
    expect(moveStack(bag, 0, null, 9, items)).toMatchObject({ error: 'bad_slot' });
    moveStack(bag, 0, null, 1, items);
    expect(JSON.stringify(bag)).toBe(snapshot);
  });
});
