import { useSyncExternalStore } from 'react';

export type Quality = 'low' | 'medium' | 'high';

export interface Settings {
  quality: Quality;
  debug: boolean;
}

/** Réglages graphiques par niveau (techniques, pas de l'équilibrage). */
export const QUALITY_PRESETS: Record<Quality, { label: string; dpr: number; antialias: boolean }> =
  {
    low: { label: 'Bas', dpr: 1, antialias: false },
    medium: { label: 'Moyen', dpr: 1.5, antialias: false },
    high: { label: 'Haut', dpr: 2, antialias: true },
  };

const KEY = 'narco.settings';

function load(): Settings {
  const debugParam = new URLSearchParams(location.search).get('debug');
  let saved: Partial<Settings> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
  } catch {
    saved = {};
  }
  const quality = saved.quality && saved.quality in QUALITY_PRESETS ? saved.quality : 'low';
  const debug = debugParam !== null ? debugParam !== '0' : saved.debug === true;
  return { quality, debug };
}

let current = load();
const listeners = new Set<() => void>();

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // ignoré
  }
  for (const fn of listeners) fn();
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
  );
}
