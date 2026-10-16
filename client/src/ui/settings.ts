import { useSyncExternalStore } from 'react';
import { gameData, resolveThemeId, type ThemeId } from '@narco/shared';

import type { Quality } from '@narco/shared';

export type { Quality };

export interface Settings {
  quality: Quality;
  /** Thème visuel (config.theme), choisi dans Options. */
  theme: ThemeId;
  debug: boolean;
}

/**
 * Réglages graphiques par niveau (techniques, pas de l'équilibrage).
 * `bloom` = intensité du post-traitement (0 = désactivé) ; `glowBoost` pousse les émissifs
 * au-dessus de 1 pour que seul eux déclenchent le bloom.
 */
export interface QualityPreset {
  label: string;
  dpr: number;
  antialias: boolean;
  bloom: number;
  glowBoost: number;
}

export const QUALITY_PRESETS: Record<Quality, QualityPreset> = {
  low: { label: 'Bas', dpr: 1, antialias: false, bloom: 0, glowBoost: 1 },
  medium: { label: 'Moyen', dpr: 1.5, antialias: false, bloom: 0.55, glowBoost: 2 },
  high: { label: 'Haut', dpr: 2, antialias: true, bloom: 0.8, glowBoost: 2.4 },
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
  // ?debug=1 / ?debug=0 : réglage mémorisé, plus besoin du paramètre ensuite.
  const debug = debugParam !== null ? debugParam !== '0' : saved.debug === true;
  const theme = resolveThemeId(gameData.config, saved.theme);
  const settings = { quality, theme, debug };
  if (debugParam !== null) {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      // ignoré
    }
  }
  return settings;
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
