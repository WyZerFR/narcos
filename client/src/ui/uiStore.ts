import { useSyncExternalStore } from 'react';

/** Panneau d'inventaire ouvert (sac seul ; le stock commun reviendra avec la caisse posable). */
export type InventoryMode = 'bag' | null;

let mode: InventoryMode = null;
const listeners = new Set<() => void>();

export function openInventory(next: Exclude<InventoryMode, null>): void {
  mode = next;
  for (const fn of listeners) fn();
}

export function closeInventory(): void {
  mode = null;
  for (const fn of listeners) fn();
}

export function useInventoryMode(): InventoryMode {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => mode,
  );
}
