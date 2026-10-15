import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { dataDir } from './env';
import { z } from 'zod';
import type { GameState } from './rooms/schema';
import {
  CartLine,
  CutJob,
  InstalledFixture,
  LaunderEntry,
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
 * ses joueurs (hors ligne), leurs sacs, le mobilier du labo et l'horloge de jeu.
 *
 * Chaque partie porte un `schemaVersion` : v1 = labo meublé, v2 = labo aménageable avec stock
 * commun, v3 = labo vide (robinet + sortie), sans stock commun, v4 = meubles posés librement
 * (position, rotation). Aucune migration : une partie d'une autre version est ignorée (log)
 * et le code redonne une partie neuve.
 */

/** Version courante du contenu d'une partie sauvegardée. */
export const SNAPSHOT_SCHEMA_VERSION = 4;

/** Fichier des parties sauvegardées, dans `NARCO_DATA_DIR` (défaut server/.data). */
export function snapshotFile(): string {
  return resolve(dataDir(), 'rooms.json');
}

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
      /** Ancien nom du solde propre (sauvegardes d'avant la banque). */
      cleanMoney: z.number().nonnegative().optional(),
      cleanBalance: z.number().nonnegative().optional(),
      launderLog: z.array(z.object({ at: z.number(), amount: z.number() })).optional(),
      // ajouté après la v4 : une ancienne sauvegarde se charge avec le compte fermé
      hasAccount: z.boolean().optional(),
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
    fixtures: z
      .record(
        z.string(),
        z.object({
          itemId: z.string(),
          x: z.number(),
          z: z.number(),
          rot: z.number().int().min(0).max(3),
        }),
      )
      .default({}),
    nextFixtureId: z.number().int().nonnegative().default(0),
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
  }),
});

export const RoomSnapshotSchema = z.object({
  code: z.string().min(1),
  /** Seule la version courante est restaurée (pas de migration). */
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
  /** Horloge de jeu au moment de la sauvegarde : elle reprend de là (temps figé pendant l'arrêt). */
  clock: z.object({ now: z.number(), scale: z.number().positive() }),
  state: StateJson,
});

export type RoomSnapshot = z.infer<typeof RoomSnapshotSchema>;

/** Lecture minimale pour trier les parties par version avant la validation complète. */
const VersionJson = z.object({
  code: z.string().catch('?'),
  schemaVersion: z.number().int().positive().default(1),
});

const FileSchema = z.object({
  version: z.literal(1),
  savedAt: z.number(),
  rooms: z.array(z.unknown()),
});

function slotsFrom(list: { itemId: string; qty: number }[]): Slot[] {
  return list.map((s) => Object.assign(new Slot(), s));
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
      cleanBalance: p.cleanBalance ?? p.cleanMoney ?? 0,
      hasAccount: p.hasAccount ?? false,
      connected: false,
    });
    player.bag.push(...slotsFrom(p.bag));
    player.cart.push(...p.cart.map((l) => Object.assign(new CartLine(), l)));
    player.cartTotal = p.cartTotal;
    player.launderLog.push(
      ...(p.launderLog ?? []).map((e) => Object.assign(new LaunderEntry(), e)),
    );
    Object.assign(player, { hunger: p.hunger, thirst: p.thirst, health: p.health });
    state.players.set(id, player);
  }
  for (const [key, shelf] of Object.entries(s.shelves))
    state.shelves.set(key, Object.assign(new ShelfState(), shelf));
  const lab = s.lab;
  state.lab.nextFixtureId = lab.nextFixtureId;
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
      const v = VersionJson.safeParse(raw);
      if (v.success && v.data.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
        console.warn(
          `[narco] partie ${v.data.code} sauvegardée en v${v.data.schemaVersion} ` +
            `(attendu v${SNAPSHOT_SCHEMA_VERSION}, labo refait à neuf) : ignorée, partie neuve.`,
        );
        continue;
      }
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
