import type { ItemDef } from './schemas';

/**
 * Inventaire à slots (sac d'un joueur, stock commun du labo). Logique pure et immuable :
 * chaque opération renvoie un nouvel inventaire ou un refus explicite, jamais d'état partiel
 * (tout ou rien).
 */

export interface Stack {
  itemId: string;
  qty: number;
}

export type Inventory = readonly (Stack | null)[];

export type ItemLookup = ReadonlyMap<string, ItemDef>;

export type InvError =
  'unknown_item' | 'not_storable' | 'bad_qty' | 'full' | 'insufficient' | 'empty_slot';

export type InvResult =
  { ok: true; inv: Inventory } | { ok: false; error: InvError; message: string };

export type TransferResult =
  { ok: true; from: Inventory; to: Inventory } | { ok: false; error: InvError; message: string };

export function emptyInventory(slots: number): Inventory {
  return Array.from({ length: slots }, () => null);
}

function fail(error: InvError, message: string): { ok: false; error: InvError; message: string } {
  return { ok: false, error, message };
}

function slotDef(items: ItemLookup, itemId: string): ItemDef | InvResult {
  const def = items.get(itemId);
  if (!def) return fail('unknown_item', `Objet inconnu : ${itemId}`);
  if (def.storage !== 'slot' || def.stackMax < 1)
    return fail('not_storable', `${def.name} ne se range pas dans un sac.`);
  return def;
}

const isDef = (v: ItemDef | InvResult): v is ItemDef => 'stackMax' in v;

/** Quantité totale d'un objet. */
export function count(inv: Inventory, itemId: string): number {
  return inv.reduce((n, s) => (s?.itemId === itemId ? n + s.qty : n), 0);
}

/** Combien d'unités de cet objet tiennent encore (piles existantes + slots libres). */
export function capacityFor(inv: Inventory, itemId: string, items: ItemLookup): number {
  const def = slotDef(items, itemId);
  if (!isDef(def)) return 0;
  return inv.reduce(
    (n, s) => n + (s === null ? def.stackMax : s.itemId === itemId ? def.stackMax - s.qty : 0),
    0,
  );
}

/** Ajoute `qty` unités : complète d'abord les piles existantes, puis les slots libres. */
export function add(inv: Inventory, itemId: string, qty: number, items: ItemLookup): InvResult {
  if (!Number.isInteger(qty) || qty <= 0) return fail('bad_qty', 'Quantité invalide.');
  const def = slotDef(items, itemId);
  if (!isDef(def)) return def;
  if (capacityFor(inv, itemId, items) < qty) return fail('full', `Plus de place pour ${def.name}.`);

  const next = inv.map((s) => (s ? { ...s } : null));
  let left = qty;
  for (const s of next) {
    if (left === 0) break;
    if (s?.itemId !== itemId) continue;
    const put = Math.min(left, def.stackMax - s.qty);
    s.qty += put;
    left -= put;
  }
  for (let i = 0; i < next.length && left > 0; i++) {
    if (next[i] !== null) continue;
    const put = Math.min(left, def.stackMax);
    next[i] = { itemId, qty: put };
    left -= put;
  }
  return { ok: true, inv: next };
}

/** Retire `qty` unités, en vidant d'abord les dernières piles. */
export function remove(inv: Inventory, itemId: string, qty: number, items: ItemLookup): InvResult {
  if (!Number.isInteger(qty) || qty <= 0) return fail('bad_qty', 'Quantité invalide.');
  const have = count(inv, itemId);
  if (have < qty) {
    const name = items.get(itemId)?.name ?? itemId;
    return fail('insufficient', `Pas assez de ${name} (${have}/${qty}).`);
  }
  const next = inv.map((s) => (s ? { ...s } : null));
  let left = qty;
  for (let i = next.length - 1; i >= 0 && left > 0; i--) {
    const s = next[i];
    if (s?.itemId !== itemId) continue;
    const take = Math.min(left, s.qty);
    s.qty -= take;
    left -= take;
    if (s.qty === 0) next[i] = null;
  }
  return { ok: true, inv: next };
}

/**
 * Déplace `qty` unités de la pile du slot `slot` de `from` vers `to` (sac ↔ stock).
 * Refusé en bloc si la destination n'a pas la place ou si la pile est trop petite.
 */
export function transfer(
  from: Inventory,
  slot: number,
  to: Inventory,
  qty: number,
  items: ItemLookup,
): TransferResult {
  const stack = from[slot];
  if (!stack) return fail('empty_slot', 'Ce slot est vide.');
  if (!Number.isInteger(qty) || qty <= 0) return fail('bad_qty', 'Quantité invalide.');
  if (stack.qty < qty) return fail('insufficient', `Il n'y en a que ${stack.qty}.`);
  const added = add(to, stack.itemId, qty, items);
  if (!added.ok) return added;
  const nextFrom = from.map((s, i) =>
    i === slot ? (stack.qty === qty ? null : { ...stack, qty: stack.qty - qty }) : s,
  );
  return { ok: true, from: nextFrom, to: added.inv };
}
