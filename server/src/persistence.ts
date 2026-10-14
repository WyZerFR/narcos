import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { GameState } from './rooms/schema';
import { Player, Pot, RackEntry, Slot } from './rooms/schema';

/**
 * Sauvegarde JSON des parties (en attendant SQLite) : un fichier unique réécrit toutes les
 * `config.persistence.snapshotSeconds`. Au démarrage, chaque partie est recréée avec son code,
 * ses joueurs (hors ligne), leurs sacs, le stock, les pots, l'étendoir et l'horloge de jeu.
 */

export const DEFAULT_SNAPSHOT_FILE = resolve(
  process.env.NARCO_DATA_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '.data'),
  'rooms.json',
);

const SlotJson = z.object({ itemId: z.string(), qty: z.number().int().nonnegative() });

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
    }),
  ),
  lab: z.object({
    stock: z.array(SlotJson).default([]),
    pots: z.record(
      z.string(),
      z.object({
        planted: z.boolean(),
        strainId: z.string(),
        growMsDone: z.number(),
        bankedAt: z.number(),
        wateredUntil: z.number(),
      }),
    ),
    rack: z.array(z.object({ strainId: z.string(), qty: z.number(), readyAt: z.number() })),
    cut: z.object({
      playerId: z.string(),
      strainId: z.string(),
      qty: z.number(),
      readyAt: z.number(),
    }),
  }),
});

export const RoomSnapshotSchema = z.object({
  code: z.string().min(1),
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
    state.players.set(id, player);
  }
  state.lab.stock.clear();
  state.lab.stock.push(...slotsFrom(s.lab.stock));
  for (const [id, pot] of Object.entries(s.lab.pots))
    state.lab.pots.set(id, Object.assign(new Pot(), pot));
  state.lab.rack.push(...s.lab.rack.map((e) => Object.assign(new RackEntry(), e)));
  Object.assign(state.lab.cut, s.lab.cut);
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
