import { themedPalette, themeOf, type GameData, type ThemeId } from '@narco/shared';

/**
 * Données du jeu vues à travers un thème : palette de base remplacée (ciel, asphalte…) ; par
 * area, la palette propre au thème (`themePalettes`) si elle existe, sinon la palette d'area si
 * le thème le demande ; couleurs des impasses remplacées par `quartierPalette`.
 */
export function themedData(data: GameData, id: ThemeId): GameData {
  const theme = themeOf(data.config, id);
  const palette = themedPalette(data.config, id);
  const areas = new Map(
    [...data.areas].map(([k, a]) => [
      k,
      { ...a, palette: a.themePalettes[id] ?? (theme.areaPalettes ? a.palette : {}) },
    ]),
  );
  const quartiers = new Map(
    [...data.quartiers].map(([k, q]) => [
      k,
      { ...q, palette: { ...q.palette, ...theme.quartierPalette } },
    ]),
  );
  return { ...data, areas, quartiers, config: { ...data.config, palette } };
}
