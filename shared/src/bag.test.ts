import { describe, expect, it } from 'vitest';
import { gameData } from './data';
import { add, count, emptyInventory, type Inventory } from './inventory';
import { bagCapacity, bagFullText, bagTierFor, equipBackpack, fitBag } from './bag';

const { economy, items } = gameData;
const BAG = economy.bag;
const shelfOf = (itemId: string) => {
  for (const shop of gameData.shops.values())
    for (const s of shop.shelves) if (s.itemId === itemId) return s;
  throw new Error(itemId);
};
const fill = (inv: Inventory, entries: [string, number][]) =>
  entries.reduce((acc, [id, qty]) => {
    const r = add(acc, id, qty, items);
    if (!r.ok) throw new Error(r.message);
    return r.inv;
  }, inv);

describe('capacité du sac', () => {
  it('6 poches au départ, 12 cases avec le sac à dos (economy.json)', () => {
    expect(bagCapacity(BAG, 0)).toBe(6);
    expect(bagCapacity(BAG, 1)).toBe(12);
    expect(bagFullText(0)).toBe('Poches pleines : libère une case.');
  });

  it('sac à dos : objet non empilable, « Équiper », vendu à l’épicerie en argent sale', () => {
    const def = items.get(BAG.backpackItemId)!;
    expect(def.stackMax).toBe(1);
    expect(def.use).toEqual({ action: 'equip_bag', label: 'Équiper' });
    const shelf = gameData.shops.get('grocery')!.shelves.find((s) => s.itemId === def.id)!;
    expect(shelf).toMatchObject({ currency: 'dirty', price: 25 });
  });

  it('équiper : l’objet est consommé, 12 cases, rien n’est perdu', () => {
    const bag = fill(emptyInventory(6), [
      ['cash_dirty', 50],
      [BAG.backpackItemId, 1],
      ['seed_base', 4],
    ]);
    const r = equipBackpack(bag, 0, BAG, items);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tier).toBe(1);
    expect(r.value.bag).toHaveLength(12);
    expect(count(r.value.bag, BAG.backpackItemId)).toBe(0);
    expect(count(r.value.bag, 'cash_dirty')).toBe(50);
    expect(count(r.value.bag, 'seed_base')).toBe(4);
  });

  it('double équipement refusé ; sans sac à dos refusé', () => {
    const bag = fill(emptyInventory(12), [[BAG.backpackItemId, 1]]);
    expect(equipBackpack(bag, 1, BAG, items)).toEqual({
      ok: false,
      message: 'Tu portes déjà un sac.',
    });
    expect(equipBackpack(emptyInventory(6), 0, BAG, items).ok).toBe(false);
  });

  it('migration : palier déduit d’une ancienne sauvegarde à 10 cases, aucun objet perdu', () => {
    const few = fill(emptyInventory(10), [['food', 1]]);
    expect(bagTierFor(BAG, undefined, few)).toBe(0);
    const many = Array.from({ length: 10 }, (_, i) => ({
      itemId: i % 2 ? 'food' : 'water',
      qty: 1,
    }));
    expect(bagTierFor(BAG, undefined, many)).toBe(1);
    expect(bagTierFor(BAG, 0, many)).toBe(0); // palier sauvegardé prioritaire
    // tassé dans 6 cases quand les piles tiennent ; jamais moins de cases que de piles
    const sparse: Inventory = [
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      { itemId: 'food', qty: 2 },
      null,
      null,
    ];
    expect(fitBag(sparse, 6)).toEqual([{ itemId: 'food', qty: 2 }, null, null, null, null, null]);
    expect(fitBag(many, 6)).toHaveLength(10);
    expect(fitBag(few, 12)).toHaveLength(12);
  });
});

describe('budget et place au départ', () => {
  it('150 $ : kit minimal + sac à dos + 2 articles de nourriture ou boisson de base', () => {
    const kit = ['pot', 'drying_rack', 'cutting_table'].map((id) => shelfOf(id).price);
    const backpack = shelfOf(BAG.backpackItemId).price;
    const food = gameData.shops
      .get('grocery')!
      .shelves.filter((s) => s.currency === 'any')
      .map((s) => s.price)
      .sort((a, b) => a - b);
    const total = kit.reduce((a, b) => a + b, 0) + backpack + food[0]! + food[1]!;
    expect(total).toBeLessThanOrEqual(economy.startingMoney.dirty);
  });

  it('6 poches : kit + 4 graines + argent + 2 consommables identiques (2 différents : 7 cases)', () => {
    const base: [string, number][] = [
      ['cash_dirty', 1],
      ['pot', 1],
      ['drying_rack', 1],
      ['cutting_table', 1],
      ['seed_base', economy.pact.startSeeds],
    ];
    expect(fill(emptyInventory(6), [...base, ['water', 2]]).filter(Boolean)).toHaveLength(6);
    // eau + sandwich : une case de trop pour les poches (constat signalé, valeurs inchangées)
    expect(add(fill(emptyInventory(6), [...base, ['water', 1]]), 'food', 1, items).ok).toBe(false);
  });
});
