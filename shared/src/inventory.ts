import { ItemCategorySchema, type ItemDef } from './schemas';

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
  'unknown_item' | 'not_storable' | 'bad_qty' | 'full' | 'insufficient' | 'empty_slot' | 'bad_slot';

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

/**
 * Glisser-déposer d'une pile entière vers un slot précis (même inventaire si `to` est null) :
 * slot vide → déplacement ; même objet → fusion jusqu'à la limite de pile, le reste reste à la
 * source ; objet différent → échange. Pur, ne modifie rien.
 */
export function moveStack(
  from: Inventory,
  fromSlot: number,
  to: Inventory | null,
  toSlot: number,
  items: ItemLookup,
): TransferResult {
  const same = to === null;
  const target = to ?? from;
  if (!Number.isInteger(fromSlot) || fromSlot < 0 || fromSlot >= from.length)
    return fail('bad_slot', 'Slot de départ invalide.');
  if (!Number.isInteger(toSlot) || toSlot < 0 || toSlot >= target.length)
    return fail('bad_slot', "Slot d'arrivée invalide.");
  const src = from[fromSlot];
  if (!src) return fail('empty_slot', 'Ce slot est vide.');
  if (same && fromSlot === toSlot) return { ok: true, from, to: from };

  const a = from.map((x) => (x ? { ...x } : null));
  const b = same ? a : target.map((x) => (x ? { ...x } : null));
  const dst = b[toSlot] ?? null;

  if (!dst) {
    b[toSlot] = { ...src };
    a[fromSlot] = null;
  } else if (dst.itemId === src.itemId) {
    const def = items.get(src.itemId);
    const room = (def?.stackMax ?? 0) - dst.qty;
    if (room <= 0) return fail('full', 'Cette pile est déjà pleine.');
    const moved = Math.min(room, src.qty);
    b[toSlot] = { ...dst, qty: dst.qty + moved };
    a[fromSlot] = src.qty - moved > 0 ? { ...src, qty: src.qty - moved } : null;
  } else {
    b[toSlot] = { ...src };
    a[fromSlot] = { ...dst };
  }
  return { ok: true, from: a, to: same ? a : b };
}

/**
 * Bouton « Trier » : regroupe les piles d'un même objet (jusqu'à la limite de pile) et range par
 * catégorie (ordre de `ItemCategorySchema`) puis par nom, cases vides à la fin. Même nombre de
 * slots, mêmes quantités : rien n'est perdu.
 */
export function sortInventory(inv: Inventory, items: ItemLookup): Inventory {
  const totals = new Map<string, number>();
  for (const s of inv) if (s) totals.set(s.itemId, (totals.get(s.itemId) ?? 0) + s.qty);
  const order = ItemCategorySchema.options;
  const ids = [...totals.keys()].sort((a, b) => {
    const da = items.get(a);
    const db = items.get(b);
    const ca = da ? order.indexOf(da.category) : order.length;
    const cb = db ? order.indexOf(db.category) : order.length;
    return ca - cb || (da?.name ?? a).localeCompare(db?.name ?? b, 'fr');
  });
  const out: (Stack | null)[] = [];
  for (const id of ids) {
    let left = totals.get(id)!;
    const max = Math.max(1, items.get(id)?.stackMax ?? left);
    while (left > 0) {
      const qty = Math.min(max, left);
      out.push({ itemId: id, qty });
      left -= qty;
    }
  }
  while (out.length < inv.length) out.push(null);
  return out;
}
