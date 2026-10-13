import type { z } from 'zod';
import configJson from '../data/config.json';
import economyJson from '../data/economy.json';
import itemsJson from '../data/items.json';
import locationsJson from '../data/locations.json';
import {
  ConfigSchema,
  EconomySchema,
  ItemsFileSchema,
  LocationsFileSchema,
  type Economy,
  type GameConfig,
  type GameLocation,
  type ItemDef,
  type Zone,
} from './schemas';

export interface GameData {
  config: GameConfig;
  economy: Economy;
  items: ReadonlyMap<string, ItemDef>;
  zones: ReadonlyMap<string, Zone>;
  locations: ReadonlyMap<string, GameLocation>;
}

export interface RawGameData {
  config: unknown;
  economy: unknown;
  items: unknown;
  locations: unknown;
}

function parse<T>(file: string, schema: z.ZodType<T>, raw: unknown): T {
  const res = schema.safeParse(raw);
  if (!res.success) {
    const details = res.error.issues
      .map((i) => `  - ${i.path.map(String).join('.') || '(racine)'} : ${i.message}`)
      .join('\n');
    throw new Error(`[data] ${file} invalide :\n${details}`);
  }
  return res.data;
}

function indexById<T extends { id: string }>(file: string, list: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const entry of list) {
    if (map.has(entry.id)) throw new Error(`[data] ${file} : id en double "${entry.id}"`);
    map.set(entry.id, entry);
  }
  return map;
}

/** Valide et indexe des données brutes (pure, testable). Lève une erreur lisible si incohérent. */
export function parseGameData(raw: RawGameData): GameData {
  const config = parse('config.json', ConfigSchema, raw.config);
  const economy = parse('economy.json', EconomySchema, raw.economy);
  const itemsFile = parse('items.json', ItemsFileSchema, raw.items);
  const locFile = parse('locations.json', LocationsFileSchema, raw.locations);

  const items = indexById('items.json', itemsFile.items);
  const zones = indexById('locations.json (zones)', locFile.zones);
  const locations = indexById('locations.json', locFile.locations);
  const strains = indexById('economy.json (strains)', economy.strains);

  const errors: string[] = [];
  for (const item of items.values()) {
    if (item.strain && !strains.has(item.strain))
      errors.push(`items.json : "${item.id}" référence la variété inconnue "${item.strain}"`);
    if (item.storage === 'slot' && item.stackMax < 1)
      errors.push(`items.json : "${item.id}" stocké en slot doit avoir stackMax >= 1`);
  }
  for (const loc of locations.values()) {
    if (!zones.has(loc.zone))
      errors.push(`locations.json : "${loc.id}" dans la zone inconnue "${loc.zone}"`);
    for (const entry of loc.catalog) {
      const known =
        entry.kind === 'item'
          ? items.has(entry.id)
          : entry.kind === 'upgrade'
            ? entry.id in economy.upgrades
            : entry.id in economy.services;
      if (!known)
        errors.push(`locations.json : "${loc.id}" vend un ${entry.kind} inconnu "${entry.id}"`);
    }
  }
  if (!locations.has(config.players.spawnLocationId))
    errors.push(`config.json : spawnLocationId "${config.players.spawnLocationId}" inconnu`);
  if (config.players.colors.length < config.room.maxPlayers)
    errors.push('config.json : il faut au moins autant de couleurs que de joueurs max');
  if (config.movement.runSpeed < config.movement.walkSpeed)
    errors.push('config.json : runSpeed doit être >= walkSpeed');
  if (errors.length > 0) throw new Error(`[data] incohérences :\n  - ${errors.join('\n  - ')}`);

  return { config, economy, items, zones, locations };
}

/** Données du jeu chargées depuis `shared/data/*.json` au démarrage. */
export const gameData: GameData = parseGameData({
  config: configJson,
  economy: economyJson,
  items: itemsJson,
  locations: locationsJson,
});
