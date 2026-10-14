import { ArraySchema } from '@colyseus/schema';
import type {
  CutJob as CutJobData,
  Inventory,
  PotState,
  RackEntry as RackData,
} from '@narco/shared';
import type { CutJob, Pot} from './schema';
import { RackEntry, Slot } from './schema';

/**
 * Passerelle entre l'état Colyseus (synchronisé) et la logique pure de `shared/` :
 * on lit l'état en objets simples, on applique une fonction pure, on réécrit le résultat.
 */

export function makeSlots(count: number): ArraySchema<Slot> {
  const arr = new ArraySchema<Slot>();
  for (let i = 0; i < count; i++) arr.push(new Slot());
  return arr;
}

export function readInventory(slots: ArraySchema<Slot>): Inventory {
  return slots.map((s) => (s.itemId ? { itemId: s.itemId, qty: s.qty } : null));
}

/** Réécrit les slots en place (seuls les slots modifiés partent dans le patch réseau). */
export function writeInventory(slots: ArraySchema<Slot>, inv: Inventory): void {
  while (slots.length < inv.length) slots.push(new Slot());
  inv.forEach((stack, i) => {
    const slot = slots[i]!;
    const itemId = stack?.itemId ?? '';
    const qty = stack?.qty ?? 0;
    if (slot.itemId !== itemId) slot.itemId = itemId;
    if (slot.qty !== qty) slot.qty = qty;
  });
}

export function readPot(p: Pot): PotState {
  return {
    planted: p.planted,
    strainId: p.strainId,
    growMsDone: p.growMsDone,
    bankedAt: p.bankedAt,
    wateredUntil: p.wateredUntil,
  };
}

export function writePot(p: Pot, s: PotState): void {
  p.planted = s.planted;
  p.strainId = s.strainId;
  p.growMsDone = s.growMsDone;
  p.bankedAt = s.bankedAt;
  p.wateredUntil = s.wateredUntil;
}

export function readRack(arr: ArraySchema<RackEntry>): RackData[] {
  return arr.map((e) => ({ strainId: e.strainId, qty: e.qty, readyAt: e.readyAt }));
}

export function writeRack(arr: ArraySchema<RackEntry>, entries: readonly RackData[]): void {
  arr.clear();
  for (const e of entries) {
    const r = new RackEntry();
    r.strainId = e.strainId;
    r.qty = e.qty;
    r.readyAt = e.readyAt;
    arr.push(r);
  }
}

export function readCut(c: CutJob): CutJobData | null {
  return c.playerId
    ? { playerId: c.playerId, strainId: c.strainId, qty: c.qty, readyAt: c.readyAt }
    : null;
}

export function writeCut(c: CutJob, job: CutJobData | null): void {
  c.playerId = job?.playerId ?? '';
  c.strainId = job?.strainId ?? '';
  c.qty = job?.qty ?? 0;
  c.readyAt = job?.readyAt ?? 0;
}
