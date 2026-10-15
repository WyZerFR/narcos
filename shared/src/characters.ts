import type { GameData } from './data';

/** Id de personnage valide : celui demandé s'il existe, sinon le défaut de config.json. */
export function resolveCharacterId(
  data: Pick<GameData, 'characters' | 'config'>,
  id: unknown,
): string {
  return typeof id === 'string' && data.characters.has(id) ? id : data.config.characters.defaultId;
}
