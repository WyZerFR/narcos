import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room as ServerRoom } from '@colyseus/core';
import type { Room as ClientRoom } from 'colyseus.js';
import { matchMaker } from '@colyseus/core';
import {
  ClientMsg,
  ROOM_NAME,
  ServerMsg,
  count,
  gameData,
  type NoticeMessage,
  type StationAction,
} from '@narco/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NarcoRoom } from '../src/rooms/NarcoRoom';
import type { GameState } from '../src/rooms/schema';
import { readInventory } from '../src/rooms/stateSync';
import { equipAll } from '../src/rooms/fixtures';
import { RoomSnapshotSchema, migrateLab } from '../src/persistence';
import { bootOn } from './helpers';

const lab = gameData.interiors.get('lab')!;
const station = (id: string) => [...lab.stations, ...lab.fixtures].find((s) => s.id === id)!;
/** Équipe tout le labo (comme la commande debug). */
const equip = (room: NarcoRoom) => equipAll(room.state, lab, room.now());
const strain = gameData.economy.strains.find((s) => s.id === 'base')!;

let colyseus: ColyseusTestServer;

beforeAll(async () => {
  colyseus = await bootOn(2572);
});
afterAll(async () => {
  await colyseus.shutdown();
});
beforeEach(async () => {
  await colyseus.cleanup();
});

type SdkRoom = ClientRoom<GameState>;

async function newGame(playerId: string) {
  const client = await colyseus.sdk.create<GameState>(ROOM_NAME, { playerId, name: 'Chimiste' });
  const room = colyseus.getRoomById<GameState>(client.roomId) as ServerRoom<GameState> as NarcoRoom;
  return { client, room };
}

async function join(room: NarcoRoom, playerId: string) {
  return colyseus.sdk.joinById<GameState>(room.roomId, { playerId, name: 'Associé' });
}

/** Place un joueur dans le labo, juste devant un poste (positionnement direct, côté serveur). */
function goTo(room: NarcoRoom, playerId: string, stationId: string) {
  const p = room.state.players.get(playerId)!;
  const st = station(stationId);
  p.zone = 'lab';
  p.x = st.position.x;
  p.z = st.position.z + st.size.d / 2 + 0.5;
}

async function act(
  client: SdkRoom,
  stationId: string,
  action: StationAction,
): Promise<NoticeMessage> {
  client.send(ClientMsg.Station, { stationId, action });
  return (await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
}

const bagOf = (room: NarcoRoom, playerId: string) =>
  readInventory(room.state.players.get(playerId)!.bag);

describe('labo — validation des actions', () => {
  it('démarre avec le stock prévu dans economy.json et un labo vide', async () => {
    const { room } = await newGame('lab-player-0001');
    const stock = readInventory(room.state.lab.stock);
    for (const { itemId, qty } of gameData.economy.lab.startingStock)
      expect(count(stock, itemId)).toBe(qty);
    expect(room.state.lab.fixtures.size).toBe(0);
    expect(room.state.lab.pots.size).toBe(0);
    expect(room.state.players.get('lab-player-0001')!.bag.length).toBe(
      gameData.economy.inventory.bagSlots,
    );
  });

  it('donne l’argent de départ et range l’argent sale dans la caisse commune', async () => {
    const { client, room } = await newGame('lab-player-0011');
    const { dirty, clean } = gameData.economy.startingMoney;
    const p = room.state.players.get('lab-player-0011')!;
    expect(count(readInventory(p.bag), 'cash_dirty')).toBe(dirty);
    expect(p.cleanMoney).toBe(clean);
    goTo(room, 'lab-player-0011', 'stock');
    const slot = readInventory(p.bag).findIndex((s) => s?.itemId === 'cash_dirty');
    client.send(ClientMsg.Transfer, { from: 'bag', slot, qty: 20 });
    await room.waitForNextMessage();
    expect(count(readInventory(p.bag), 'cash_dirty')).toBe(dirty - 20);
    expect(count(readInventory(room.state.lab.stock), 'cash_dirty')).toBe(20);
  });

  it('refuse depuis la rue, de trop loin et sans objet', async () => {
    const { client, room } = await newGame('lab-player-0002');
    expect((await act(client, 'pot_1', 'plant')).ok).toBe(false); // dans la rue
    const p = room.state.players.get('lab-player-0002')!;
    p.zone = 'lab';
    p.x = 6;
    p.z = 4;
    expect((await act(client, 'pot_1', 'plant')).text).toMatch(/Trop loin/);
    goTo(room, 'lab-player-0002', 'pot_1');
    expect((await act(client, 'pot_1', 'plant')).text).toMatch(/Rien n'est installé/);
    equip(room);
    expect((await act(client, 'pot_1', 'plant')).text).toMatch(/graine/);
    expect((await act(client, 'pot_1', 'cut')).ok).toBe(false); // mauvaise action pour ce poste
  });

  it('transfère sac ↔ stock près de la caisse seulement', async () => {
    const { client, room } = await newGame('lab-player-0003');
    goTo(room, 'lab-player-0003', 'pot_1');
    client.send(ClientMsg.Transfer, { from: 'stock', slot: 0, qty: 2 });
    expect(((await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage).ok).toBe(false);
    goTo(room, 'lab-player-0003', 'stock');
    client.send(ClientMsg.Transfer, { from: 'stock', slot: 0, qty: 1 });
    await room.waitForNextMessage();
    expect(count(bagOf(room, 'lab-player-0003'), 'water')).toBe(1);
    expect(count(readInventory(room.state.lab.stock), 'water')).toBe(
      gameData.economy.lab.startingStock.find((s) => s.itemId === 'water')!.qty - 1,
    );
  });

  it('montre le même stock aux deux joueurs', async () => {
    const { client: a, room } = await newGame('lab-player-0004');
    const b = await join(room, 'lab-player-0005');
    goTo(room, 'lab-player-0004', 'stock');
    a.send(ClientMsg.Transfer, { from: 'stock', slot: 0, qty: 1 });
    await room.waitForNextMessage();
    await room.waitForNextPatch();
    await new Promise((r) => setTimeout(r, 100));
    const view = (s: GameState) => JSON.stringify(s.lab.stock.map((x) => [x.itemId, x.qty]));
    expect(view(a.state)).toBe(view(room.state));
    expect(view(b.state)).toBe(view(room.state));
  });
});

describe('labo — production', () => {
  it('double récolte simultanée : un seul gagne', async () => {
    const { client: a, room } = await newGame('lab-player-0006');
    const b = await join(room, 'lab-player-0007');
    equip(room);
    const pot = room.state.lab.pots.get('pot_1')!;
    // pot prêt : planté et arrosé suffisamment longtemps dans le passé
    const now = room.now();
    Object.assign(pot, {
      planted: true,
      strainId: 'base',
      growMsDone: strain.growSeconds * 1000,
      bankedAt: now,
      wateredUntil: now,
    });
    goTo(room, 'lab-player-0006', 'pot_1');
    goTo(room, 'lab-player-0007', 'pot_1');
    a.send(ClientMsg.Station, { stationId: 'pot_1', action: 'harvest' });
    b.send(ClientMsg.Station, { stationId: 'pot_1', action: 'harvest' });
    const [na, nb] = (await Promise.all([
      a.waitForMessage(ServerMsg.Notice),
      b.waitForMessage(ServerMsg.Notice),
    ])) as NoticeMessage[];
    expect([na!.ok, nb!.ok].filter(Boolean)).toHaveLength(1);
    const fresh = (id: string) => count(bagOf(room, id), 'plant_fresh_base');
    expect(fresh('lab-player-0006') + fresh('lab-player-0007')).toBe(strain.freshPerPlant);
    expect(pot.planted).toBe(false);
  });

  it('cycle complet graine → pochon, à plusieurs, horloge x60', async () => {
    const { client: a, room } = await newGame('lab-player-0008');
    const b = await join(room, 'lab-player-0009');
    a.send(ClientMsg.Debug, { cmd: 'timeScale', scale: 60 });
    await a.waitForMessage(ServerMsg.Notice);
    // équiper depuis la rue est refusé, depuis le labo accepté
    a.send(ClientMsg.Debug, { cmd: 'equipLab' });
    expect(((await a.waitForMessage(ServerMsg.Notice)) as NoticeMessage).ok).toBe(false);
    goTo(room, 'lab-player-0008', 'stock');
    a.send(ClientMsg.Debug, { cmd: 'equipLab' });
    expect(((await a.waitForMessage(ServerMsg.Notice)) as NoticeMessage).ok).toBe(true);
    expect(room.state.lab.fixtures.size).toBe(lab.fixtures.length);
    // sans lampes pour ce test : vitesse de pousse normale, arrosages comptés comme avant
    for (const f of lab.fixtures) if (f.accepts === 'lamp') room.state.lab.fixtures.delete(f.id);
    for (const pot of room.state.lab.pots.values()) pot.rate = 1;

    // A prend une graine (debug) et plante
    a.send(ClientMsg.Debug, { cmd: 'give', itemId: 'seed_base', qty: 1 });
    await a.waitForMessage(ServerMsg.Notice);
    goTo(room, 'lab-player-0008', 'pot_1');
    expect((await act(a, 'pot_1', 'plant')).ok).toBe(true);

    // B remplit une bouteille et arrose, autant de fois que nécessaire
    const waterings = Math.ceil(strain.growSeconds / strain.waterEverySeconds);
    for (let i = 0; i < waterings; i++) {
      goTo(room, 'lab-player-0009', 'water');
      expect((await act(b, 'water', 'fill')).ok).toBe(true);
      goTo(room, 'lab-player-0009', 'pot_1');
      let n = await act(b, 'pot_1', 'water');
      while (!n.ok && /humide/.test(n.text)) {
        await new Promise((r) => setTimeout(r, 200));
        n = await act(b, 'pot_1', 'water');
      }
      expect(n.ok).toBe(true);
    }

    // A récolte dès que c'est prêt
    let h = await act(a, 'pot_1', 'harvest');
    while (!h.ok) {
      await new Promise((r) => setTimeout(r, 200));
      h = await act(a, 'pot_1', 'harvest');
    }
    expect(count(bagOf(room, 'lab-player-0008'), 'plant_fresh_base')).toBe(strain.freshPerPlant);

    // étendre, attendre le séchage, décrocher
    goTo(room, 'lab-player-0008', 'rack_2');
    expect((await act(a, 'rack_2', 'hang')).ok).toBe(true);
    let c = await act(a, 'rack_2', 'collect');
    while (!c.ok) {
      await new Promise((r) => setTimeout(r, 200));
      c = await act(a, 'rack_2', 'collect');
    }
    expect(count(bagOf(room, 'lab-player-0008'), 'plant_dried_base')).toBe(strain.freshPerPlant);

    // découper : les pochons arrivent dans le sac à la fin de la découpe
    goTo(room, 'lab-player-0008', 'table_1');
    expect((await act(a, 'table_1', 'cut')).ok).toBe(true);
    const finished = (await a.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
    expect(finished.text).toMatch(/Pochon/);
    expect(count(bagOf(room, 'lab-player-0008'), 'pouch_base')).toBe(
      strain.freshPerPlant * strain.pouchesPerDried,
    );
  }, 20000);
});

describe('sauvegarde', () => {
  it('restaure une partie depuis son snapshot (même code, même stock, joueurs hors ligne)', async () => {
    const { client, room } = await newGame('lab-player-0010');
    goTo(room, 'lab-player-0010', 'stock');
    client.send(ClientMsg.Transfer, { from: 'stock', slot: 0, qty: 2 });
    await room.waitForNextMessage();
    equip(room);
    room.state.lab.pots.get('pot_3')!.planted = true;
    const snap = RoomSnapshotSchema.parse(JSON.parse(JSON.stringify(room.snapshot())));
    const code = room.roomId;
    await client.leave();
    await room.disconnect();

    const restored = (await matchMaker.createRoom(ROOM_NAME, { restore: snap })) as {
      roomId: string;
    };
    expect(restored.roomId).toBe(code);
    const again = colyseus.getRoomById<GameState>(code) as ServerRoom<GameState> as NarcoRoom;
    const p = again.state.players.get('lab-player-0010')!;
    expect(p.connected).toBe(false);
    expect(p.zone).toBe('lab');
    expect(count(readInventory(p.bag), 'water')).toBe(2);
    expect(readInventory(again.state.lab.stock)).toEqual(readInventory(room.state.lab.stock));
    expect([...again.state.lab.fixtures.keys()].sort()).toEqual(
      [...room.state.lab.fixtures.keys()].sort(),
    );
    expect(again.state.lab.pots.get('pot_3')!.planted).toBe(true);

    // le joueur revient avec son playerId et retrouve tout
    await colyseus.sdk.joinById(code, { playerId: 'lab-player-0010', name: 'Chimiste' });
    expect(p.connected).toBe(true);
  });
});

describe('sauvegarde — migration v1 (labo meublé) → v2 (labo aménageable)', () => {
  const v1 = {
    code: 'ABCD',
    clock: { now: 50_000, scale: 1 },
    state: {
      code: 'ABCD',
      players: {
        'old-player-0001': {
          id: 'old-player-0001',
          name: 'Ancien',
          color: '#fff',
          x: 1,
          z: 2,
          zone: 'lab',
          bag: [
            { itemId: 'cash_dirty', qty: 42 },
            { itemId: 'plant_dried_base', qty: 2 },
          ],
        },
      },
      lab: {
        stock: [{ itemId: 'seed_base', qty: 5 }],
        pots: {
          pot_1: {
            planted: true,
            strainId: 'base',
            growMsDone: 1000,
            bankedAt: 40_000,
            wateredUntil: 60_000,
          },
          pot_2: { planted: false, strainId: '', growMsDone: 0, bankedAt: 0, wateredUntil: 0 },
        },
        rack: [{ strainId: 'base', qty: 3, readyAt: 70_000 }],
        cut: { playerId: 'old-player-0001', strainId: 'base', qty: 2, readyAt: 55_000 },
      },
    },
  };

  it('migrateLab installe les emplacements d’origine avec leur contenu', () => {
    const snap = RoomSnapshotSchema.parse(v1);
    expect(snap.schemaVersion).toBe(1);
    const lab2 = migrateLab(snap.state.lab, snap.schemaVersion);
    expect(Object.keys(lab2.fixtures).sort()).toEqual(['pot_1', 'pot_2', 'rack_1', 'table_1']);
    expect(lab2.fixtures.pot_1!.itemId).toBe('pot');
    expect(lab2.fixtures.rack_1!.itemId).toBe('drying_rack');
    expect(lab2.fixtures.table_1!.itemId).toBe('cutting_table');
    expect(lab2.pots.pot_1).toMatchObject({ planted: true, growMsDone: 1000, rate: 1 });
    expect(lab2.racks.rack_1!.entries).toEqual(v1.state.lab.rack);
    expect(lab2.cuts.table_1).toEqual(v1.state.lab.cut);
    expect(lab2.rack).toBeUndefined();
    // une sauvegarde v2 n'est pas touchée
    expect(migrateLab(lab2, 2)).toBe(lab2);
  });

  it('restaure une partie v1 sans perdre sacs, stock ni plantes', async () => {
    const snap = RoomSnapshotSchema.parse(v1);
    await matchMaker.createRoom(ROOM_NAME, { restore: snap });
    const room = colyseus.getRoomById<GameState>('ABCD') as ServerRoom<GameState> as NarcoRoom;
    const p = room.state.players.get('old-player-0001')!;
    expect(count(readInventory(p.bag), 'cash_dirty')).toBe(42);
    expect(count(readInventory(p.bag), 'plant_dried_base')).toBe(2);
    expect(count(readInventory(room.state.lab.stock), 'seed_base')).toBe(5);
    expect(room.state.lab.pots.get('pot_1')!.planted).toBe(true);
    expect(room.state.lab.racks.get('rack_1')!.entries.length).toBe(1);
    expect(room.state.lab.cuts.get('table_1')!.playerId).toBe('old-player-0001');
    // la sauvegarde suivante est en v2
    expect(room.snapshot().schemaVersion).toBe(2);
    await room.disconnect();
  });
});
