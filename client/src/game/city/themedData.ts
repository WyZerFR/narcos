import { themedPalette, themeOf, type GameData, type ThemeId } from '@narco/shared';

/**
 * Données du jeu vues à travers un thème : palette de base remplacée (ciel, asphalte…) ; les
 * palettes par area (areas.json) ne s'appliquent que si le thème le demande.
 */
export function themedData(data: GameData, id: ThemeId): GameData {
  const palette = themedPalette(data.config, id);
  const areas = themeOf(data.config, id).areaPalettes
    ? data.areas
    : new Map([...data.areas].map(([k, a]) => [k, { ...a, palette: {} }]));
  return { ...data, areas, config: { ...data.config, palette } };
}
