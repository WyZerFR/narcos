import { themedPalette, type GameData, type ThemeId } from '@narco/shared';

/** Données du jeu vues à travers un thème : seule la palette de base change (ciel, asphalte…). */
export function themedData(data: GameData, id: ThemeId): GameData {
  return { ...data, config: { ...data.config, palette: themedPalette(data.config, id) } };
}
