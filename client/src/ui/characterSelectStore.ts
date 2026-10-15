import { useSyncExternalStore } from 'react';
import { gameData } from '@narco/shared';

/**
 * Écran de sélection du personnage : ouvert après le lobby tant que le joueur n'a pas choisi
 * dans cette partie (mémorisé par code de partie dans le navigateur), puis depuis Options tant
 * que `config.characters.locked` est faux.
 */

const KEY = 'narco.characterChosen';
let open = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function chosenCodes(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

export const characterSelectAvailable = !gameData.config.characters.locked;

/** À l'arrivée dans une partie : ouvre l'écran si rien n'a encore été choisi pour ce code. */
export function offerCharacterSelect(code: string): void {
  if (characterSelectAvailable && !chosenCodes().includes(code)) openCharacterSelect();
}

export function openCharacterSelect(): void {
  if (!characterSelectAvailable || open) return;
  open = true;
  emit();
}

/** Ferme l'écran ; avec `code`, le choix est mémorisé pour cette partie. */
export function closeCharacterSelect(code?: string): void {
  if (code) {
    try {
      // les 20 dernières parties suffisent
      localStorage.setItem(
        KEY,
        JSON.stringify([code, ...chosenCodes().filter((c) => c !== code)].slice(0, 20)),
      );
    } catch {
      // stockage indisponible (navigation privée) : l'écran reviendra à la prochaine connexion
    }
  }
  open = false;
  emit();
}

export function useCharacterSelectOpen(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => open,
  );
}
