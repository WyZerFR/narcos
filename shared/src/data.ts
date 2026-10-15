import type { z } from 'zod';
import configJson from '../data/config.json';
import economyJson from '../data/economy.json';
import itemsJson from '../data/items.json';
import locationsJson from '../data/locations.json';
import zonesJson from '../data/zones.json';
import shopsJson from '../data/shops.json';
import npcsJson from '../data/npcs.json';
import dialoguesJson from '../data/dialogues.json';
import areasJson from '../data/areas.json';
import quartiersJson from '../data/quartiers.json';
import {
  ConfigSchema,
  EconomySchema,
  FixtureTypeSchema,
  ItemsFileSchema,
  LocationsFileSchema,
  ZonesFileSchema,
  ShopsFileSchema,
  NpcsFileSchema,
  DialoguesFileSchema,
  AreasFileSchema,
  QuartiersFileSchema,
  type Area,
  type QuartierParams,
  type QuartierColliders,
  type Dialogue,
  type NpcsFile,
  type Shop,
  type Interior,
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
import { interiorBounds, interiorObstacles } from './zones';

import { obstaclesFrom } from './collision';
import { dialogueVars, textVars } from './dialogue';
import { areaAt, areasEnvelope } from './areas';
import { checkQuartier, generateQuartier, quartierFrame, type QuartierLayout } from './quartiers';

/** Catégories d'objets payables en « any » (compte ou espèces) : nourriture et boissons. */
const ANY_CURRENCY_CATEGORIES: ReadonlySet<string> = new Set(['food', 'drink', 'water']);

/** Dialogues : nœuds uniques, liens valides, variables connues, postes « talk » reliés. */
function checkDialogues(
  dialogues: ReadonlyMap<string, Dialogue>,
  interiors: ReadonlyMap<string, Interior>,
  vars: Readonly<Record<string, string>>,
): string[] {
  const errors: string[] = [];
  for (const d of dialogues.values()) {
    const where = `dialogues.json : "${d.id}"`;
    const ids = new Set<string>();
    for (const n of d.nodes) {
      if (ids.has(n.id)) errors.push(`${where} : nœud en double "${n.id}"`);
      ids.add(n.id);
    }
    for (const s of d.start)
      if (!ids.has(s.node)) errors.push(`${where} : nœud d'entrée inconnu "${s.node}"`);
    if (d.start.at(-1)?.requires?.length)
      errors.push(`${where} : la dernière entrée de start doit être sans condition`);
    for (const n of d.nodes) {
      for (const v of textVars(n.text))
        if (!(v in vars)) errors.push(`${where} : variable inconnue {${v}} dans "${n.id}"`);
      const choiceIds = new Set<string>();
      for (const c of n.choices) {
        if (choiceIds.has(c.id)) errors.push(`${where} : choix en double "${n.id}/${c.id}"`);
        choiceIds.add(c.id);
        if (c.next !== null && !ids.has(c.next))
          errors.push(`${where} : "${n.id}/${c.id}" mène au nœud inconnu "${c.next}"`);
      }
    }
  }
  for (const interior of interiors.values())
    for (const st of interior.stations) {
      if (st.kind === 'talk' && !(st.dialogue && dialogues.has(st.dialogue)))
        errors.push(`zones.json : "${interior.id}/${st.id}" : dialogue manquant ou inconnu`);
      if (st.kind !== 'talk' && st.dialogue)
        errors.push(`zones.json : "${interior.id}/${st.id}" : dialogue sur un poste non « talk »`);
    }
  return errors;
}

export interface GameData {
  config: GameConfig;
  economy: Economy;
  items: ReadonlyMap<string, ItemDef>;
  zones: ReadonlyMap<string, Zone>;
  locations: ReadonlyMap<string, GameLocation>;
  /** Immeubles de remplissage (sans fonction). */
  blocks: readonly Block[];
  /** Intérieurs (`zones.json`), indexés par id de zone. */
  interiors: ReadonlyMap<string, Interior>;
  /** Magasins (`shops.json`), indexés par id d'intérieur. */
  shops: ReadonlyMap<string, Shop>;
  /** PNJ de la rue (`npcs.json`). */
  npcs: NpcsFile;
  /** Dialogues (`dialogues.json`), indexés par id. */
  dialogues: ReadonlyMap<string, Dialogue>;
  /** Areas de la rue (`areas.json`) dans l'ordre du fichier (la rue centrale d'abord). */
  areas: ReadonlyMap<string, Area>;
  /** Paramètres des impasses (`quartiers.json`), indexés par id. */
  quartiers: ReadonlyMap<string, QuartierParams>;
  /** Emprises de collision du décor des quartiers. */
  quartierColliders: QuartierColliders;
  /** Impasses générées (même graine = même résultat sur client et serveur), par id de quartier. */
  quartierLayouts: ReadonlyMap<string, QuartierLayout>;
}

export interface RawGameData {
  config: unknown;
  economy: unknown;
  items: unknown;
  locations: unknown;
  zones: unknown;
  shops: unknown;
  npcs: unknown;
  dialogues: unknown;
  areas: unknown;
  quartiers: unknown;
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

/**
 * Areas : la rue centrale existe, pas de chevauchement, carte = enveloppe des areas, lieux et
 * point de départ dans une area, impasses cohérentes avec leur bâtiment du bout.
 */
function checkAreas(
  config: GameConfig,
  areas: ReadonlyMap<string, Area>,
  locations: GameLocation[],
  quartiers: ReadonlyMap<string, QuartierParams>,
): string[] {
  const errors: string[] = [];
  const list = [...areas.values()];
  if (list[0]?.id !== 'street') errors.push('areas.json : la première area doit être "street"');
  for (const [i, a] of list.entries())
    for (const b of list.slice(i + 1))
      if (rectsOverlap(a.bounds, b.bounds))
        errors.push(`areas.json : "${a.id}" chevauche "${b.id}"`);
  const env = areasEnvelope(list);
  const w = config.world.bounds;
  if (env.minX !== w.minX || env.maxX !== w.maxX || env.minZ !== w.minZ || env.maxZ !== w.maxZ)
    errors.push(
      `config.json : world.bounds doit valoir l'enveloppe des areas ${JSON.stringify(env)}`,
    );
  for (const loc of locations)
    if (!list.some((a) => rectContainsRect(a.bounds, footprint(loc))))
      errors.push(`locations.json : "${loc.id}" n'est entièrement dans aucune area`);
  for (const p of [config.players.spawn, ...config.decor.cartons])
    if (areaAt(list, p)?.id !== 'street')
      errors.push('config.json : le départ (spawn, carton) doit être dans la rue centrale');
  for (const q of quartiers.values())
    errors.push(...checkQuartier(q, areas, new Map(locations.map((l) => [l.id, l]))));
  const used = [...quartiers.values()].map((q) => q.areaId);
  for (const a of list)
    if (a.id !== 'street' && !used.includes(a.id))
      errors.push(`areas.json : "${a.id}" n'a pas de quartier dans quartiers.json`);
  return errors;
}

/** Cohérence des intérieurs : porte d'entrée, postes dans la pièce, sortie, point d'apparition libre. */
function checkInteriors(
  interiors: Interior[],
  locations: ReadonlyMap<string, GameLocation>,
): string[] {
  const errors: string[] = [];
  for (const interior of interiors) {
    const where = `zones.json : "${interior.id}"`;
    const entrance = locations.get(interior.entranceLocationId);
    if (!entrance || entrance.kind !== 'building')
      errors.push(`${where} : entrée "${interior.entranceLocationId}" inconnue ou sans porte`);
    const bounds = interiorBounds(interior);
    const ids = new Set<string>();
    for (const st of interior.stations) {
      if (ids.has(st.id)) errors.push(`${where} : poste en double "${st.id}"`);
      ids.add(st.id);
      if (!rectContainsRect(bounds, rectFromCenter(st.position, st.size)))
        errors.push(`${where} : le poste "${st.id}" sort de la pièce`);
    }
    if (interior.stations.filter((st) => st.kind === 'exit').length !== 1)
      errors.push(`${where} : il faut exactement une sortie`);
    const solids = interiorObstacles(interior);
    for (const [i, a] of solids.entries())
      for (const b of solids.slice(i + 1))
        if (rectsOverlap(a, b)) errors.push(`${where} : deux obstacles se chevauchent`);
    if (
      !rectContainsPoint(bounds, interior.spawn) ||
      solids.some((r) => rectContainsPoint(r, interior.spawn))
    )
      errors.push(`${where} : point d'apparition hors pièce ou dans un obstacle`);
  }
  return errors;
}

/** Valide et indexe des données brutes (pure, testable). Lève une erreur lisible si incohérent. */
export function parseGameData(raw: RawGameData): GameData {
  const config = parse('config.json', ConfigSchema, raw.config);
  const economy = parse('economy.json', EconomySchema, raw.economy);
  const itemsFile = parse('items.json', ItemsFileSchema, raw.items);
  const locFile = parse('locations.json', LocationsFileSchema, raw.locations);
  const zonesFile = parse('zones.json', ZonesFileSchema, raw.zones);
  const shopsFile = parse('shops.json', ShopsFileSchema, raw.shops);
  const npcs = parse('npcs.json', NpcsFileSchema, raw.npcs);
  const dialoguesFile = parse('dialogues.json', DialoguesFileSchema, raw.dialogues);
  const areasFile = parse('areas.json', AreasFileSchema, raw.areas);
  const quartiersFile = parse('quartiers.json', QuartiersFileSchema, raw.quartiers);

  const items = indexById('items.json', itemsFile.items);
  const zones = indexById('locations.json (zones)', locFile.zones);
  const locations = indexById('locations.json', locFile.locations);
  const strains = indexById('economy.json (strains)', economy.strains);
  const interiors = indexById('zones.json', zonesFile.interiors);
  const shops = new Map(shopsFile.shops.map((sh) => [sh.interiorId, sh]));
  const dialogues = indexById('dialogues.json', dialoguesFile.dialogues);
  const areas = indexById('areas.json', areasFile.areas);
  const quartiers = indexById('quartiers.json', quartiersFile.quartiers);
  const quartierLayouts = new Map<string, QuartierLayout>();
  const streetArea = areas.get('street');
  for (const q of quartiers.values()) {
    const area = areas.get(q.areaId);
    const frame = area && streetArea ? quartierFrame(q, area.bounds, streetArea.bounds) : null;
    if (frame)
      quartierLayouts.set(
        q.id,
        generateQuartier(q, frame, quartiersFile.colliders, config.decor.carSize),
      );
  }

  const errors: string[] = [];
  for (const item of items.values()) {
    if (item.strain && !strains.has(item.strain))
      errors.push(`items.json : "${item.id}" référence la variété inconnue "${item.strain}"`);
    if (item.storage === 'slot' && item.stackMax < 1)
      errors.push(`items.json : "${item.id}" stocké en slot doit avoir stackMax >= 1`);
    if (Boolean(item.placeable) !== (item.use?.action === 'place'))
      errors.push(`items.json : "${item.id}" : "placeable" et use.action "place" vont ensemble`);
    if (item.placeable && item.storage !== 'slot')
      errors.push(`items.json : "${item.id}" posable mais pas rangeable dans le sac`);
  }
  for (const type of FixtureTypeSchema.options) {
    if (![...items.values()].some((it) => it.placeable?.type === type))
      errors.push(`items.json : aucun objet posable de type "${type}"`);
    if (config.debug.equipKit[type] > economy.lab.furniture.maxPerType[type])
      errors.push(`config.json : debug.equipKit.${type} dépasse le plafond du labo`);
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
  errors.push(...checkInteriors(zonesFile.interiors, locations));
  for (const shop of shopsFile.shops) {
    const interior = interiors.get(shop.interiorId);
    if (!interior) {
      errors.push(`shops.json : intérieur inconnu "${shop.interiorId}"`);
      continue;
    }
    const sold = new Set<string>();
    for (const shelf of shop.shelves) {
      const st = interior.stations.find((x) => x.id === shelf.stationId);
      if (st?.kind !== 'shelf')
        errors.push(`shops.json : "${shop.interiorId}/${shelf.stationId}" n'est pas une étagère`);
      if (sold.has(shelf.stationId))
        errors.push(`shops.json : étagère en double "${shelf.stationId}"`);
      sold.add(shelf.stationId);
      const def = items.get(shelf.itemId);
      if (!def || def.storage !== 'slot')
        errors.push(`shops.json : objet "${shelf.itemId}" inconnu ou non rangeable`);
      // « any » (compte ou espèces) est réservé à la nourriture et aux boissons de base
      if (shelf.currency === 'any' && def && !ANY_CURRENCY_CATEGORIES.has(def.category))
        errors.push(`shops.json : "${shelf.itemId}" ne peut pas se payer en « any »`);
    }
    for (const st of interior.stations)
      if (st.kind === 'shelf' && !sold.has(st.id))
        errors.push(`shops.json : l'étagère "${shop.interiorId}/${st.id}" n'a rien à vendre`);
    if (!interior.stations.some((x) => x.kind === 'counter'))
      errors.push(`zones.json : le magasin "${shop.interiorId}" n'a pas de comptoir`);
  }

  for (const interior of zonesFile.interiors) {
    const ids = new Set<string>();
    for (const st of interior.stations) {
      if (ids.has(st.id)) errors.push(`zones.json : "${interior.id}" : poste en double "${st.id}"`);
      ids.add(st.id);
    }
    if (interiorObstacles(interior).some((r) => rectContainsPoint(r, interior.spawn)))
      errors.push(`zones.json : "${interior.id}" : un poste couvre le point d'apparition`);
    if (interior.furnishable && !interior.stations.some((s) => s.kind === 'exit'))
      errors.push(`zones.json : "${interior.id}" aménageable sans porte de sortie`);
  }
  const lamp = economy.lab.lamp;
  if (lamp.maxLamps * lamp.growReductionPerLamp >= 1)
    errors.push('economy.json : lab.lamp, maxLamps × growReductionPerLamp doit rester < 1');
  for (const strain of economy.strains)
    for (const category of ['seed', 'plant_fresh', 'plant_dried', 'pouch'] as const)
      if (![...items.values()].some((it) => it.category === category && it.strain === strain.id))
        errors.push(`items.json : pas de "${category}" pour la variété "${strain.id}"`);
  indexById('npcs.json (profiles)', npcs.profiles);
  for (const profile of npcs.profiles)
    for (const id of profile.strains)
      if (!strains.has(id))
        errors.push(`npcs.json : "${profile.id}" veut la variété inconnue "${id}"`);
  if (!npcs.profiles.some((p) => p.interestChance > 0))
    errors.push("npcs.json : aucun profil n'achète jamais rien");
  const streetObstacles = obstaclesFrom({
    config,
    locations,
    blocks: locFile.blocks,
    areas,
    quartierLayouts,
  }).map((r) => expandRect(r, config.npc.radius));
  for (const [i, wp] of npcs.waypoints.entries())
    if (
      !rectContainsPoint(config.world.bounds, wp) ||
      streetObstacles.some((r) => rectContainsPoint(r, wp))
    )
      errors.push(`npcs.json : point de passage n°${i} hors carte ou dans un bâtiment`);
  errors.push(...checkDialogues(dialogues, interiors, dialogueVars(economy)));
  for (const loc of locations.values()) {
    if (loc.dialogue && !dialogues.has(loc.dialogue))
      errors.push(`locations.json : "${loc.id}" : dialogue inconnu "${loc.dialogue}"`);
    if (loc.dialogue && zonesFile.interiors.some((i) => i.entranceLocationId === loc.id))
      errors.push(`locations.json : "${loc.id}" a un intérieur : le dialogue se tient dedans`);
  }
  if (items.get(economy.pact.seedItemId)?.category !== 'seed')
    errors.push(`economy.json : pact.seedItemId "${economy.pact.seedItemId}" n'est pas une graine`);
  if (config.players.colors.length < config.room.maxPlayers)
    errors.push('config.json : il faut au moins autant de couleurs que de joueurs max');
  if (config.movement.runSpeed < config.movement.walkSpeed)
    errors.push('config.json : runSpeed doit être >= walkSpeed');
  errors.push(...checkAreas(config, areas, locFile.locations, quartiers));
  for (const layout of quartierLayouts.values()) {
    const area = areas.get(layout.areaId)!.bounds;
    const solids = [...locFile.locations.filter((l) => l.kind === 'building'), ...locFile.blocks];
    for (const r of layout.colliders) {
      if (!rectContainsRect(area, r))
        errors.push(`quartiers.json : "${layout.id}" : un élément sort de l'area`);
      if (solids.some((s) => rectsOverlap(footprint(s), r)))
        errors.push(`quartiers.json : "${layout.id}" : un élément chevauche un bâtiment`);
    }
  }
  if (errors.length > 0) throw new Error(`[data] incohérences :\n  - ${errors.join('\n  - ')}`);

  return {
    config,
    economy,
    items,
    zones,
    locations,
    blocks: locFile.blocks,
    interiors,
    shops,
    npcs,
    dialogues,
    areas,
    quartiers,
    quartierColliders: quartiersFile.colliders,
    quartierLayouts,
  };
}

/** Données du jeu chargées depuis `shared/data/*.json` au démarrage. */
export const gameData: GameData = parseGameData({
  config: configJson,
  economy: economyJson,
  items: itemsJson,
  locations: locationsJson,
  zones: zonesJson,
  shops: shopsJson,
  npcs: npcsJson,
  dialogues: dialoguesJson,
  areas: areasJson,
  quartiers: quartiersJson,
});
