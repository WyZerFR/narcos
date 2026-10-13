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
  type Block,
  type Economy,
  type GameConfig,
  type GameLocation,
  type ItemDef,
  type Zone,
} from './schemas';
import {
  expandRect,
  rectContainsPoint,
  rectContainsRect,
  rectFromCenter,
  rectsOverlap,
  type Rect,
} from './geometry';
import { footprint, interactionPoint } from './locations';

export interface GameData {
  config: GameConfig;
  economy: Economy;
  items: ReadonlyMap<string, ItemDef>;
  zones: ReadonlyMap<string, Zone>;
  locations: ReadonlyMap<string, GameLocation>;
  /** Immeubles de remplissage (sans fonction). */
  blocks: readonly Block[];
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

/** Cohérence spatiale de la carte : emprises, portes, routes, point de départ. */
function checkMap(
  config: GameConfig,
  locations: GameLocation[],
  blocks: Block[],
  zones: ReadonlyMap<string, Zone>,
): string[] {
  const errors: string[] = [];
  const bounds = config.world.bounds;
  const streets = config.map.roads.map((r) =>
    expandRect(rectFromCenter(r, r), config.map.sidewalkWidth),
  );
  const solids: { id: string; rect: Rect }[] = [];

  for (const loc of locations) {
    const rect = footprint(loc);
    const zone = zones.get(loc.zone);
    if (zone && !rectContainsRect(zone.bounds, rect))
      errors.push(`locations.json : "${loc.id}" déborde de sa zone`);
    if (loc.kind === 'building') {
      if (!loc.door) errors.push(`locations.json : le bâtiment "${loc.id}" n'a pas de porte`);
      solids.push({ id: loc.id, rect });
    }
    if (!rectContainsPoint(bounds, interactionPoint(loc)))
      errors.push(`locations.json : le point d'interaction de "${loc.id}" est hors carte`);
  }
  for (const b of blocks) solids.push({ id: b.id, rect: footprint(b) });

  for (const [i, a] of solids.entries()) {
    if (!rectContainsRect(bounds, a.rect)) errors.push(`"${a.id}" déborde de la carte`);
    if (streets.some((s) => rectsOverlap(s, a.rect)))
      errors.push(`"${a.id}" empiète sur une route ou un trottoir`);
    for (const b of solids.slice(i + 1)) {
      if (rectsOverlap(a.rect, b.rect)) errors.push(`"${a.id}" chevauche "${b.id}"`);
    }
  }
  const spawn = config.players.spawn;
  if (!rectContainsPoint(bounds, spawn)) errors.push('config.json : players.spawn hors carte');
  if (solids.some((s) => rectContainsPoint(s.rect, spawn)))
    errors.push('config.json : players.spawn est dans un bâtiment');
  return errors;
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
  errors.push(...checkMap(config, locFile.locations, locFile.blocks, zones));
  if (config.players.colors.length < config.room.maxPlayers)
    errors.push('config.json : il faut au moins autant de couleurs que de joueurs max');
  if (config.movement.runSpeed < config.movement.walkSpeed)
    errors.push('config.json : runSpeed doit être >= walkSpeed');
  if (errors.length > 0) throw new Error(`[data] incohérences :\n  - ${errors.join('\n  - ')}`);

  return { config, economy, items, zones, locations, blocks: locFile.blocks };
}

/** Données du jeu chargées depuis `shared/data/*.json` au démarrage. */
export const gameData: GameData = parseGameData({
  config: configJson,
  economy: economyJson,
  items: itemsJson,
  locations: locationsJson,
});
