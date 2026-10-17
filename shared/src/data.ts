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
import charactersJson from '../data/characters.json';
import palettesJson from '../data/palettes.json';
import propsJson from '../data/props.json';
import placementsJson from '../data/placements.json';
import {
  PalettesFileSchema,
  PropsFileSchema,
  PlacementsFileSchema,
  type PlacementsFile,
  type PropsFile,
  type Prop,
  type Swatch,
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
  CharactersFileSchema,
  type Character,
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
  type Vec2,
} from './geometry';
import { footprint, interactionPoint } from './locations';
import { interiorBounds, interiorObstacles, scaleInterior } from './zones';

import { findSlits, obstaclesFrom } from './collision';
import { checkFacades, checkPlacements } from './props';
import { dialogueVars, textVars } from './dialogue';
import { areaAt, areaContainsRect, areaRects, areasEnvelope } from './areas';
import { checkQuartier, generateQuartier, quartierFrame, type QuartierLayout } from './quartiers';
import { checkTheme } from './theme';
import { islandLayout, type IslandLayout } from './island';
import { expandBlocks } from './cityBlocks';
import { airportLayout } from './airport';

/**
 * Catégories payables en « any » (propre d'abord, sale sinon) : nourriture, boissons, matériel
 * de production (meubles du labo) et équipement (sac à dos).
 */
const ANY_CURRENCY_CATEGORIES: ReadonlySet<string> = new Set([
  'food',
  'drink',
  'water',
  'furniture',
  'gear',
]);

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
  /** Area de référence des prix (`areas.json` referenceAreaId : prix et demande × 1). */
  marketReference: Area;
  /** Paramètres des impasses (`quartiers.json`), indexés par id. */
  quartiers: ReadonlyMap<string, QuartierParams>;
  /** Emprises de collision du décor des quartiers. */
  quartierColliders: QuartierColliders;
  /** Impasses générées (même graine = même résultat sur client et serveur), par id de quartier. */
  quartierLayouts: ReadonlyMap<string, QuartierLayout>;
  /** Côte de l'île (contour des areas), plages et palmiers : décor tiré de `config.island`. */
  island: IslandLayout;
  /** Personnages jouables (`characters.json`), dans l'ordre du fichier. */
  characters: ReadonlyMap<string, Character>;
  /** Zones personnalisables (`palettes.json`), dans l'ordre du fichier. */
  appearanceSlots: ReadonlyMap<string, AppearanceSlot>;
  /** Décor 3D importé (`props.json`), indexé par id. */
  props: ReadonlyMap<string, Prop>;
  /** Gain de couleur par catégorie de décor importé (`props.json` tint), selon le thème. */
  propsTint: PropsFile['tint'];
  /** Néons des modèles importés (`props.json` emissive) : activés et intensité. */
  propsEmissive: PropsFile['emissive'];
  /** Décor généré remplacé par des modèles et props posés (`placements.json`). */
  placements: PlacementsFile;
}

/** Zone personnalisable d'un personnage et ses teintes. */
export interface AppearanceSlot {
  id: string;
  name: string;
  /** Rang dans le shader (1..n ; 0 = couleur d'origine). */
  index: number;
  swatches: readonly Swatch[];
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
  characters: unknown;
  palettes: unknown;
  /** Absent : `props.json`. */
  props?: unknown;
  /** Absent : `placements.json`. */
  placements?: unknown;
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
 * Aéroport : area connue, sans PNJ ; portail sur la clôture, débouchant sur une area marchable ;
 * piste, hangars, avions et conteneurs dans l'enceinte, volumes sans chevauchement.
 */
function checkAirport(config: GameConfig, areas: ReadonlyMap<string, Area>): string[] {
  const p = config.airport;
  const area = areas.get(p.areaId);
  if (!area) return [`config.json : airport.areaId "${p.areaId}" inconnue`];
  const errors: string[] = [];
  const at = (what: string) => `config.json : airport, ${what}`;
  if (area.npcCount > 0)
    errors.push(`areas.json : "${area.id}" (aéroport) ne doit pas avoir de PNJ`);
  const l = airportLayout(p, area);
  const g = p.gate;
  const onFence =
    g.axis === 'x'
      ? (g.z === l.inner.minZ || g.z === l.inner.maxZ) &&
        g.x - g.width / 2 > l.inner.minX &&
        g.x + g.width / 2 < l.inner.maxX
      : (g.x === l.inner.minX || g.x === l.inner.maxX) &&
        g.z - g.width / 2 > l.inner.minZ &&
        g.z + g.width / 2 < l.inner.maxZ;
  if (!onFence) errors.push(at('le portail doit être sur la clôture'));
  // juste devant le portail, côté extérieur : une area marchable (on le voit, on y bute)
  const out = p.fence.inset + 0.5;
  const front =
    g.axis === 'x'
      ? { x: g.x, z: g.z === l.inner.maxZ ? g.z + out : g.z - out }
      : { x: g.x === l.inner.maxX ? g.x + out : g.x - out, z: g.z };
  const outside = areaAt(areas.values(), front);
  if (!outside || outside.locked) errors.push(at('le portail ne donne sur aucune area marchable'));
  const volumes = [
    ...l.hangars.map((r, i) => ({ id: `hangar ${i}`, r })),
    ...l.planeRects.map((r, i) => ({ id: `avion ${i}`, r })),
    ...l.containerRects.map((r, i) => ({ id: `conteneur ${i}`, r })),
  ];
  for (const v of [...volumes, { id: 'piste', r: l.runway }])
    if (!rectContainsRect(l.inner, v.r)) errors.push(at(`${v.id} hors de l'enceinte`));
  for (const [i, a] of volumes.entries())
    for (const b of volumes.slice(i + 1))
      if (rectsOverlap(a.r, b.r)) errors.push(at(`${a.id} chevauche ${b.id}`));
  return errors;
}

/**
 * Centre-ville et commerces : réglages des tours, immeubles dans une area marchable, façades de
 * repère avec enseigne (jamais le nom d'un lieu interactif), panneaux d'entrée sur une route de
 * leur area.
 */
function checkCity(
  config: GameConfig,
  areas: ReadonlyMap<string, Area>,
  blocks: Block[],
  locations: GameLocation[],
): string[] {
  const errors: string[] = [];
  const t = config.city.towers;
  if (t.minWidth > t.maxWidth) errors.push('config.json : city.towers.minWidth > maxWidth');
  if (t.heights[0] > t.heights[1]) errors.push('config.json : city.towers.heights inversées');
  const walkable = [...areas.values()].filter((a) => !a.locked);
  const names = new Set(locations.map((l) => l.name.toLowerCase()));
  for (const b of blocks) {
    if (!walkable.some((a) => areaContainsRect(a, footprint(b))))
      errors.push(`locations.json : l'immeuble "${b.id}" n'est dans aucune area marchable`);
    if (b.style !== 'filler' && b.style !== 'tower' && !b.sign)
      errors.push(`locations.json : la façade "${b.id}" (${b.style}) n'a pas d'enseigne`);
    if (b.sign && names.has(b.sign.toLowerCase()))
      errors.push(`locations.json : l'enseigne de "${b.id}" reprend le nom d'un lieu`);
  }
  const roads = config.map.roads.map((r) => rectFromCenter(r, r));
  for (const g of config.map.areaGates) {
    const area = areas.get(g.areaId);
    if (!area || area.locked)
      errors.push(`config.json : map.areaGates, area "${g.areaId}" inconnue ou verrouillée`);
    else if (areaAt([area], g) === null)
      errors.push(`config.json : map.areaGates, le panneau de "${g.areaId}" est hors de son area`);
    if (!roads.some((r) => rectContainsPoint(r, g)))
      errors.push(
        `config.json : map.areaGates, le panneau de "${g.areaId}" n'est pas sur une route`,
      );
  }
  return errors;
}

/**
 * Areas : pas de chevauchement, carte = enveloppe des areas, lieux dans une area marchable,
 * départ dans la première area, quartiers cohérents avec leur bâtiment du bout.
 */
function checkAreas(
  config: GameConfig,
  areas: ReadonlyMap<string, Area>,
  locations: GameLocation[],
  quartiers: ReadonlyMap<string, QuartierParams>,
): string[] {
  const errors: string[] = [];
  const list = [...areas.values()];
  const first = list[0];
  if (!first || first.locked) errors.push('areas.json : la première area (départ) est verrouillée');
  // chevauchement : deux pavages d'areas qui se recouvrent (bords communs autorisés)
  const tiles = list.map(areaRects);
  for (const [i, a] of list.entries())
    for (const [j, b] of list.entries())
      if (j > i && tiles[i]!.some((r) => tiles[j]!.some((o) => rectsOverlap(r, o))))
        errors.push(`areas.json : "${a.id}" chevauche "${b.id}"`);
  const env = areasEnvelope(list);
  const w = config.world.bounds;
  if (env.minX !== w.minX || env.maxX !== w.maxX || env.minZ !== w.minZ || env.maxZ !== w.maxZ)
    errors.push(
      `config.json : world.bounds doit valoir l'enveloppe des areas ${JSON.stringify(env)}`,
    );
  for (const loc of locations)
    if (!list.some((a) => !a.locked && areaContainsRect(a, footprint(loc))))
      errors.push(`locations.json : "${loc.id}" n'est entièrement dans aucune area marchable`);
  for (const p of [config.players.spawn, ...config.decor.cartons])
    if (!first || areaAt(list, p)?.id !== first.id)
      errors.push(`config.json : le départ (spawn, carton) doit être dans l'area "${first?.id}"`);
  for (const q of quartiers.values())
    errors.push(...checkQuartier(q, areas, new Map(locations.map((l) => [l.id, l]))));
  const used = [...quartiers.values()].map((q) => q.areaId);
  if (new Set(used).size !== used.length)
    errors.push('quartiers.json : deux quartiers dans la même area');
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
    // entrée : porte d'un bâtiment, ou lieu caché au sol (trappe)
    if (!entrance || (entrance.kind !== 'building' && !entrance.hidden))
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

/**
 * Points de passage des PNJ d'une area : ceux de `npcs.json` qui y tombent, plus ceux générés
 * par son quartier (U ou impasse).
 */
export function areaWaypoints(
  data: Pick<GameData, 'areas' | 'npcs' | 'quartierLayouts'>,
  areaId: string,
): Vec2[] {
  return [
    ...data.npcs.waypoints.filter((wp) => areaAt(data.areas.values(), wp)?.id === areaId),
    ...[...data.quartierLayouts.values()]
      .filter((l) => l.areaId === areaId)
      .flatMap((l) => l.waypoints),
  ];
}

/** Valide et indexe des données brutes (pure, testable). Lève une erreur lisible si incohérent. */
export function parseGameData(raw: RawGameData): GameData {
  const config = parse('config.json', ConfigSchema, raw.config);
  const economy = parse('economy.json', EconomySchema, raw.economy);
  const itemsFile = parse('items.json', ItemsFileSchema, raw.items);
  const locFile = parse('locations.json', LocationsFileSchema, raw.locations);
  // îlots de tours découpés une fois (graine) : collisions, rendu et vérifications voient les tours
  const blocks = expandBlocks(locFile.blocks, config.city.towers);
  const parsedZones = parse('zones.json', ZonesFileSchema, raw.zones);
  // agrandissement des intérieurs (layoutScale) appliqué une fois, avant toute vérification
  const passage = 2 * config.world.playerRadius + config.collision.passageMargin;
  const zonesFile = {
    ...parsedZones,
    interiors: parsedZones.interiors.map((i) => scaleInterior(i, passage)),
  };
  const shopsFile = parse('shops.json', ShopsFileSchema, raw.shops);
  const npcs = parse('npcs.json', NpcsFileSchema, raw.npcs);
  const dialoguesFile = parse('dialogues.json', DialoguesFileSchema, raw.dialogues);
  const areasFile = parse('areas.json', AreasFileSchema, raw.areas);
  const quartiersFile = parse('quartiers.json', QuartiersFileSchema, raw.quartiers);
  const characters = indexById(
    'characters.json',
    parse('characters.json', CharactersFileSchema, raw.characters).characters,
  );
  const palettesFile = parse('palettes.json', PalettesFileSchema, raw.palettes);
  const appearanceSlots = new Map(
    [...indexById('palettes.json (slots)', palettesFile.slots).values()].map(
      (s, i): [string, AppearanceSlot] => [
        s.id,
        { id: s.id, name: s.name, index: i + 1, swatches: palettesFile.palettes[s.palette] ?? [] },
      ],
    ),
  );

  const propsFile = parse('props.json', PropsFileSchema, raw.props ?? propsJson);
  const props = indexById('props.json', propsFile.props);
  const placements = parse(
    'placements.json',
    PlacementsFileSchema,
    raw.placements ?? placementsJson,
  );

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
  for (const q of quartiers.values()) {
    const area = areas.get(q.areaId);
    if (area)
      quartierLayouts.set(
        q.id,
        generateQuartier(
          q,
          quartierFrame(q, area.bounds),
          quartiersFile.colliders,
          config.decor.carSize,
          area.bounds,
          2 * config.world.playerRadius + config.collision.passageMargin,
        ),
      );
  }

  const errors: string[] = [];
  if (config.world.interactExitMargin > config.world.interactTolerance)
    errors.push('config.json : world.interactExitMargin doit rester sous interactTolerance');
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
  errors.push(...checkMap(config, locFile.locations, blocks, zones));
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
    blocks,
    areas,
    quartierLayouts,
    props,
    placements,
  }).map((r) => expandRect(r, config.npc.radius));
  for (const [i, wp] of npcs.waypoints.entries())
    if (
      !rectContainsPoint(config.world.bounds, wp) ||
      streetObstacles.some((r) => rectContainsPoint(r, wp))
    )
      errors.push(`npcs.json : point de passage n°${i} hors carte ou dans un bâtiment`);
  for (const layout of quartierLayouts.values())
    for (const wp of layout.waypoints)
      if (
        areaAt(areas.values(), wp)?.id !== layout.areaId ||
        streetObstacles.some((r) => rectContainsPoint(r, wp))
      )
        errors.push(`quartiers.json : "${layout.id}" : point de passage PNJ bloqué ou hors area`);
  const npcTotal = [...areas.values()].reduce((n, a) => n + a.npcCount, 0);
  if (npcTotal > config.npc.maxTotal)
    errors.push(
      `areas.json : ${npcTotal} PNJ au total, plafond config.npc.maxTotal = ${config.npc.maxTotal}`,
    );
  for (const a of areas.values()) {
    const wps = areaWaypoints({ areas, npcs, quartierLayouts }, a.id);
    if (a.npcCount > 0 && a.locked)
      errors.push(`areas.json : "${a.id}" est verrouillée, elle ne peut pas avoir de PNJ`);
    if (a.npcCount > 0 && wps.length < 2)
      errors.push(`areas.json : "${a.id}" a des PNJ mais moins de 2 points de passage`);
  }
  errors.push(...checkDialogues(dialogues, interiors, dialogueVars(economy)));
  for (const loc of locations.values()) {
    // un lieu interactif doit faire quelque chose ; la réplique d'entrée va avec un intérieur
    const enters = zonesFile.interiors.some((i) => i.entranceLocationId === loc.id);
    if (enters !== Boolean(loc.enterText))
      errors.push(
        `locations.json : "${loc.id}" : enterText seulement (et obligatoire) pour un lieu à intérieur`,
      );
    if (loc.dialogue && !dialogues.has(loc.dialogue))
      errors.push(`locations.json : "${loc.id}" : dialogue inconnu "${loc.dialogue}"`);
    if (loc.dialogue && zonesFile.interiors.some((i) => i.entranceLocationId === loc.id))
      errors.push(`locations.json : "${loc.id}" a un intérieur : le dialogue se tient dedans`);
  }
  if (items.get(economy.pact.seedItemId)?.category !== 'seed')
    errors.push(`economy.json : pact.seedItemId "${economy.pact.seedItemId}" n'est pas une graine`);
  if (config.players.colors.length < config.room.maxPlayers)
    errors.push('config.json : il faut au moins autant de couleurs que de joueurs max');
  const bagRules = economy.bag;
  if (bagRules.backpackSlots <= bagRules.pocketSlots)
    errors.push('economy.json : bag.backpackSlots doit dépasser bag.pocketSlots');
  const backpack = items.get(bagRules.backpackItemId);
  if (backpack?.use?.action !== 'equip_bag' || backpack.stackMax !== 1)
    errors.push(
      `economy.json : bag.backpackItemId "${bagRules.backpackItemId}" : objet équipable non empilable attendu`,
    );
  for (const it of items.values())
    if (it.use?.action === 'equip_bag' && it.id !== bagRules.backpackItemId)
      errors.push(`items.json : "${it.id}" s'équipe comme sac mais n'est pas bag.backpackItemId`);
  if (config.movement.runSpeed < config.movement.walkSpeed)
    errors.push('config.json : runSpeed doit être >= walkSpeed');
  const net = config.netSmoothing;
  if (net.remoteDelayMs < config.room.patchRateMs)
    errors.push('config.json : netSmoothing.remoteDelayMs doit couvrir au moins room.patchRateMs');
  if (net.correctionIgnoreDistance >= net.correctionSnapDistance)
    errors.push('config.json : correctionIgnoreDistance doit être < correctionSnapDistance');
  if (!characters.has(config.characters.defaultId))
    errors.push(`config.json : characters.defaultId "${config.characters.defaultId}" inconnu`);
  if (characters.size > config.characters.maxCount)
    errors.push(
      `characters.json : ${characters.size} personnages, max ${config.characters.maxCount}`,
    );
  for (const s of palettesFile.slots)
    if (!palettesFile.palettes[s.palette])
      errors.push(`palettes.json : slot ${s.id}, palette "${s.palette}" inconnue`);
  for (const [name, list] of Object.entries(palettesFile.palettes))
    if (new Set(list.map((w) => w.id)).size !== list.length)
      errors.push(`palettes.json : palette ${name}, id de teinte en double`);
  for (const c of characters.values()) {
    const seen = new Set<string>();
    for (const [slot, materials] of Object.entries(c.slots)) {
      if (!appearanceSlots.has(slot))
        errors.push(`characters.json : ${c.id}, slot "${slot}" absent de palettes.json`);
      for (const m of materials) {
        if (seen.has(m)) errors.push(`characters.json : ${c.id}, matériau "${m}" dans deux slots`);
        seen.add(m);
      }
    }
  }
  const categories = new Set(config.characters.categories.map((c) => c.id));
  for (const c of characters.values())
    if (!categories.has(c.category))
      errors.push(`characters.json : ${c.id}, catégorie "${c.category}" inconnue`);
  const loco = config.characters.locomotion;
  if (!(
    loco.walkStop < loco.walkStart &&
    loco.walkStart < loco.runStop &&
    loco.runStop < loco.runStart
  ))
    errors.push('config.json : locomotion, il faut walkStop < walkStart < runStop < runStart');
  if (loco.timeScale.min > loco.timeScale.max)
    errors.push('config.json : locomotion.timeScale.min doit être ≤ max');
  const ring = config.characters.ring;
  if (ring.innerRadius >= ring.outerRadius)
    errors.push('config.json : characters.ring.innerRadius doit être < outerRadius');
  for (const p of props.values()) {
    if (!p.keepColors && !p.tint)
      errors.push(`props.json : "${p.id}" sans keepColors doit avoir une teinte (tint)`);
    const folder = p.folder ?? p.category;
    if (!p.model.startsWith(`models/${folder}/`))
      errors.push(`props.json : "${p.id}" doit être dans models/${folder}/`);
    if (p.family) {
      if (p.category !== 'batiments')
        errors.push(`props.json : "${p.id}" (famille ${p.family}) doit être un bâtiment`);
      if (!p.footprint) errors.push(`props.json : "${p.id}" (famille ${p.family}) sans emprise`);
      else if (
        p.collision?.shape !== 'rect' ||
        p.collision.w > p.footprint.w ||
        p.collision.d > p.footprint.d
      )
        errors.push(`props.json : "${p.id}" : collision rectangle hors de son emprise`);
    }
    if (p.triangles > config.props.budget[p.category].maxTriangles)
      errors.push(`props.json : "${p.id}" dépasse le budget de triangles de ${p.category}`);
  }
  errors.push(
    ...checkPlacements(
      config,
      props,
      placements,
      areas,
      locations.values(),
      quartierLayouts.values(),
      obstaclesFrom({
        config,
        locations,
        blocks,
        areas,
        quartierLayouts,
        props,
        placements: { ...placements, areas: {} },
      }),
    ),
  );
  errors.push(...checkFacades(props, placements, locations, blocks));
  errors.push(...checkAreas(config, areas, locFile.locations, quartiers));
  errors.push(...checkCity(config, areas, blocks, locFile.locations));
  errors.push(...checkAirport(config, areas));
  errors.push(
    ...checkTheme(config, locFile.locations, blocks, quartiersFile.quartiers, areas.values()),
  );
  const marketReference = areas.get(areasFile.referenceAreaId);
  if (!marketReference || marketReference.locked)
    errors.push('areas.json : referenceAreaId inconnue ou verrouillée');
  else if (marketReference.priceMultiplier !== 1 || marketReference.demandRate !== 1)
    errors.push("areas.json : l'area de référence doit avoir prix et demande à 1");
  // écarts : deux obstacles se touchent ou laissent un vrai passage (diamètre + marge)
  const minGap = 2 * config.world.playerRadius + config.collision.passageMargin;
  const fmt = (r: Rect) => `(${r.minX.toFixed(2)}, ${r.minZ.toFixed(2)})`;
  for (const interior of zonesFile.interiors) {
    const b = interiorBounds(interior);
    const walls = [
      { minX: b.minX - 1, maxX: b.maxX + 1, minZ: b.minZ - 1, maxZ: b.minZ },
      { minX: b.minX - 1, maxX: b.maxX + 1, minZ: b.maxZ, maxZ: b.maxZ + 1 },
      { minX: b.minX - 1, maxX: b.minX, minZ: b.minZ, maxZ: b.maxZ },
      { minX: b.maxX, maxX: b.maxX + 1, minZ: b.minZ, maxZ: b.maxZ },
    ];
    for (const [a, c] of findSlits([...interiorObstacles(interior), ...walls], minGap))
      errors.push(
        `zones.json : "${interior.id}" : fente de moins de ${minGap} m entre ${fmt(a)} et ${fmt(c)}`,
      );
  }
  for (const layout of quartierLayouts.values())
    for (const [a, c] of findSlits(layout.colliders, minGap))
      errors.push(`quartiers.json : "${layout.id}" : fente entre ${fmt(a)} et ${fmt(c)}`);
  for (const layout of quartierLayouts.values()) {
    const q = quartiers.get(layout.id)!;
    // chaque jardin déclaré a été généré (ses deux maisons existent de ce côté)
    if (layout.gardens.length !== q.hiddenGardens.length)
      errors.push(
        `quartiers.json : "${layout.id}" : jardin caché sur une maison absente (houseIndex trop grand)`,
      );
    const touches = (a: Rect, b: Rect) =>
      a.minX <= b.maxX && b.minX <= a.maxX && a.minZ <= b.maxZ && b.minZ <= a.maxZ;
    for (const g of layout.gardens) {
      if (!touches(g.passage, g.garden))
        errors.push(`quartiers.json : "${layout.id}" : un passage ne mène pas à son jardin`);
      // passage libre, rien de solide autour de l'emplacement central (hors coffre du leurre)
      const around = rectFromCenter(g.spot, { w: 2, d: 2 });
      // le coffre cassé d'un leurre occupe l'emplacement : seul obstacle toléré au centre
      const isChest = (r: Rect) => g.brokenChest !== null && rectContainsPoint(r, g.spot);
      if (
        layout.colliders.some(
          (r) => rectsOverlap(r, g.passage) || (rectsOverlap(r, around) && !isChest(r)),
        )
      )
        errors.push(`quartiers.json : "${layout.id}" : passage ou cœur d'un jardin encombré`);
    }
    const c = layout.cellar;
    const id = q.cellarLocationId;
    const trap = id ? locations.get(id) : undefined;
    if (c && (!trap || trap.kind !== 'area' || !trap.hidden))
      errors.push(
        `quartiers.json : "${layout.id}" : trappe "${id}" inconnue, non cachée ou solide`,
      );
    if (c?.trapdoor && trap) {
      // la trappe est où le générateur l'a mise, dans le vrai jardin
      const t = c.trapdoor;
      if (Math.hypot(trap.position.x - t.x, trap.position.z - t.z) > 0.05)
        errors.push(
          `locations.json : "${trap.id}" doit être en ${t.x.toFixed(2)}, ${t.z.toFixed(2)} (trappe générée)`,
        );
      if (!rectContainsPoint(c.garden, trap.position))
        errors.push(`locations.json : "${trap.id}" n'est pas dans le jardin caché`);
    }
  }
  for (const layout of quartierLayouts.values()) {
    const area = areas.get(layout.areaId)!;
    const solids = [...locFile.locations.filter((l) => l.kind === 'building'), ...blocks];
    for (const r of layout.colliders) {
      if (!areaContainsRect(area, r))
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
    blocks,
    interiors,
    shops,
    npcs,
    dialogues,
    areas,
    marketReference: marketReference!,
    quartiers,
    quartierColliders: quartiersFile.colliders,
    quartierLayouts,
    island: islandLayout(areas.values(), config.island),
    characters,
    appearanceSlots,
    propsTint: propsFile.tint,
    propsEmissive: propsFile.emissive,
    props,
    placements,
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
  characters: charactersJson,
  palettes: palettesJson,
  props: propsJson,
  placements: placementsJson,
});
