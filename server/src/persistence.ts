import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { GameState } from './rooms/schema';
import {
  CartLine,
  CutJob,
  InstalledFixture,
  Player,
  Pot,
  RackEntry,
  RackState,
  ShelfState,
  Slot,
} from './rooms/schema';

/**
 * Sauvegarde JSON des parties (en attendant SQLite) : un fichier unique réécrit toutes les
 * `config.persistence.snapshotSeconds`. Au démarrage, chaque partie est recréée avec son code,
 * ses joueurs (hors ligne), leurs sacs, le stock, le mobilier du labo et l'horloge de jeu.
 *
 * Chaque partie porte un `schemaVersion` : v1 = labo livré meublé (2 pots, un étendoir, une
 * table), v2 = labo aménageable. Une partie v1 est migrée en installant les emplacements
 * d'origine avec leur contenu (plantes, séchage, découpe) ; sacs et stock sont repris tels quels.
 */

/** Version courante du contenu d'une partie sauvegardée. */
export const SNAPSHOT_SCHEMA_VERSION = 2;

/** Emplacements équipés par la migration v1 → v2 (le labo meublé d'avant). */
export const V1_FIXTURES = {
  pots: ['pot_1', 'pot_2'],
  rack: 'rack_1',
  table: 'table_1',
  items: { pot: 'pot', rack: 'drying_rack', table: 'cutting_table' },
} as const;

export const DEFAULT_SNAPSHOT_FILE = resolve(
  process.env.NARCO_DATA_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '.data'),
  'rooms.json',
);

const SlotJson = z.object({ itemId: z.string(), qty: z.number().int().nonnegative() });

const RackEntryJson = z.object({ strainId: z.string(), qty: z.number(), readyAt: z.number() });
const CutJson = z.object({
  playerId: z.string(),
  strainId: z.string(),
  qty: z.number(),
  readyAt: z.number(),
});

const StateJson = z.object({
  code: z.string(),
  players: z.record(
    z.string(),
    z.object({
      id: z.string(),
      name: z.string(),
      color: z.string(),
      x: z.number(),
      z: z.number(),
      rotY: z.number().default(0),
      zone: z.string().default('street'),
      bag: z.array(SlotJson).default([]),
      cleanMoney: z.number().nonnegative().default(0),
      cart: z
        .array(
          z.object({
            stationId: z.string(),
            itemId: z.string(),
            qty: z.number(),
            unitPrice: z.number(),
          }),
        )
        .default([]),
      cartTotal: z.number().nonnegative().default(0),
      hunger: z.number().default(100),
      thirst: z.number().default(100),
      health: z.number().default(100),
    }),
  ),
  shelves: z.record(z.string(), z.object({ stock: z.number().int() })).default({}),
  lab: z.object({
    stock: z.array(SlotJson).default([]),
    fixtures: z.record(z.string(), z.object({ itemId: z.string() })).default({}),
    pots: z
      .record(
        z.string(),
        z.object({
          planted: z.boolean(),
          strainId: z.string(),
          growMsDone: z.number(),
          bankedAt: z.number(),
          wateredUntil: z.number(),
          rate: z.number().positive().default(1),
        }),
      )
      .default({}),
    racks: z.record(z.string(), z.object({ entries: z.array(RackEntryJson) })).default({}),
    cuts: z.record(z.string(), CutJson).default({}),
    /** v1 : étendoir et table uniques. */
    rack: z.array(RackEntryJson).optional(),
    cut: CutJson.optional(),
  }),
});

export const RoomSnapshotSchema = z.object({
  code: z.string().min(1),
  /** Absent dans les sauvegardes d'avant le labo aménageable (= 1). */
  schemaVersion: z.number().int().positive().default(1),
  /** Horloge de jeu au moment de la sauvegarde : elle reprend de là (temps figé pendant l'arrêt). */
  clock: z.object({ now: z.number(), scale: z.number().positive() }),
  state: StateJson,
});

export type RoomSnapshot = z.infer<typeof RoomSnapshotSchema>;

const FileSchema = z.object({
  version: z.literal(1),
  savedAt: z.number(),
  rooms: z.array(z.unknown()),
});

function slotsFrom(list: { itemId: string; qty: number }[]): Slot[] {
  return list.map((s) => Object.assign(new Slot(), s));
}

type LabJson = RoomSnapshot['state']['lab'];

/** Convertit un labo v1 (meublé d'office) en labo v2 : emplacements d'origine installés. */
export function migrateLab(lab: LabJson, version: number): LabJson {
  if (version >= 2) return lab;
  const { rack, cut, ...rest } = lab;
  const out: LabJson = { ...rest, fixtures: {}, pots: {}, racks: {}, cuts: {} };
  for (const id of V1_FIXTURES.pots) {
    const pot = lab.pots[id];
    if (!pot) continue; // pot pas installé dans la partie v1
    out.fixtures[id] = { itemId: V1_FIXTURES.items.pot };
    out.pots[id] = { ...pot, rate: 1 };
  }
  out.fixtures[V1_FIXTURES.rack] = { itemId: V1_FIXTURES.items.rack };
  out.racks[V1_FIXTURES.rack] = { entries: rack ?? [] };
  out.fixtures[V1_FIXTURES.table] = { itemId: V1_FIXTURES.items.table };
  out.cuts[V1_FIXTURES.table] = cut ?? { playerId: '', strainId: '', qty: 0, readyAt: 0 };
  return out;
}

/** Remplit un état vierge depuis un snapshot. Les joueurs reviennent hors ligne. */
export function hydrateState(state: GameState, snap: RoomSnapshot): void {
  const s = snap.state;
  state.code = snap.code;
  for (const [id, p] of Object.entries(s.players)) {
    const player = new Player();
    Object.assign(player, {
      id: p.id,
      name: p.name,
      color: p.color,
      x: p.x,
      z: p.z,
      rotY: p.rotY,
      zone: p.zone,
      cleanMoney: p.cleanMoney,
      connected: false,
    });
    player.bag.push(...slotsFrom(p.bag));
    player.cart.push(...p.cart.map((l) => Object.assign(new CartLine(), l)));
    player.cartTotal = p.cartTotal;
    Object.assign(player, { hunger: p.hunger, thirst: p.thirst, health: p.health });
    state.players.set(id, player);
  }
  for (const [key, shelf] of Object.entries(s.shelves))
    state.shelves.set(key, Object.assign(new ShelfState(), shelf));
  state.lab.stock.clear();
  state.lab.stock.push(...slotsFrom(s.lab.stock));
  const lab = migrateLab(s.lab, snap.schemaVersion);
  for (const [id, f] of Object.entries(lab.fixtures))
    state.lab.fixtures.set(id, Object.assign(new InstalledFixture(), f));
  for (const [id, pot] of Object.entries(lab.pots))
    state.lab.pots.set(id, Object.assign(new Pot(), pot));
  for (const [id, rack] of Object.entries(lab.racks)) {
    const r = new RackState();
    r.entries.push(...rack.entries.map((e) => Object.assign(new RackEntry(), e)));
    state.lab.racks.set(id, r);
  }
  for (const [id, cut] of Object.entries(lab.cuts))
    state.lab.cuts.set(id, Object.assign(new CutJob(), cut));
  state.clock.now = snap.clock.now;
  state.clock.scale = snap.clock.scale;
}

/** Écriture atomique (fichier temporaire puis renommage) : jamais de fichier à moitié écrit. */
export function writeSnapshotFile(file: string, rooms: RoomSnapshot[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: Date.now(), rooms }));
  renameSync(tmp, file);
}

/** Lit les parties sauvegardées ; une partie illisible est ignorée (avec un message). */
export function readSnapshotFile(file: string): RoomSnapshot[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = FileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    const rooms: RoomSnapshot[] = [];
    for (const raw of parsed.rooms) {
      const r = RoomSnapshotSchema.safeParse(raw);
      if (r.success) rooms.push(r.data);
      else
        console.warn('[narco] partie sauvegardée illisible, ignorée :', r.error.issues[0]?.message);
    }
    return rooms;
  } catch (err) {
    console.warn('[narco] sauvegarde illisible, ignorée :', (err as Error).message);
    return [];
  }
}
