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
import { RoomSnapshotSchema } from '../src/persistence';
import { bootOn } from './helpers';

const lab = gameData.interiors.get('lab')!;
const station = (id: string) => lab.stations.find((s) => s.id === id)!;
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
  it('démarre avec le stock et les pots prévus dans economy.json', async () => {
    const { room } = await newGame('lab-player-0001');
    const stock = readInventory(room.state.lab.stock);
    for (const { itemId, qty } of gameData.economy.lab.startingStock)
      expect(count(stock, itemId)).toBe(qty);
    expect(room.state.lab.pots.size).toBe(gameData.economy.lab.startPots);
    expect(room.state.players.get('lab-player-0001')!.bag.length).toBe(
      gameData.economy.inventory.bagSlots,
    );
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
    expect((await act(client, 'pot_1', 'plant')).text).toMatch(/graine/);
    expect((await act(client, 'pot_1', 'cut')).ok).toBe(false); // mauvaise action pour ce poste
  });

  it('transfère sac ↔ stock près de la caisse seulement', async () => {
    const { client, room } = await newGame('lab-player-0003');
    goTo(room, 'lab-player-0003', 'pot_1');
    client.send(ClientMsg.Transfer, { from: 'stock', slot: 0, qty: 2 });
    expect(((await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage).ok).toBe(false);
    goTo(room, 'lab-player-0003', 'stock');
    client.send(ClientMsg.Transfer, { from: 'stock', slot: 0, qty: 2 });
    await room.waitForNextMessage();
    expect(count(bagOf(room, 'lab-player-0003'), 'seed_base')).toBe(2);
    expect(count(readInventory(room.state.lab.stock), 'seed_base')).toBe(
      gameData.economy.lab.startingStock.find((s) => s.itemId === 'seed_base')!.qty - 2,
    );
  });

  it('montre le même stock aux deux joueurs', async () => {
    const { client: a, room } = await newGame('lab-player-0004');
    const b = await join(room, 'lab-player-0005');
    goTo(room, 'lab-player-0004', 'stock');
    a.send(ClientMsg.Transfer, { from: 'stock', slot: 1, qty: 1 });
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

    // A prend des graines dans la caisse et plante
    goTo(room, 'lab-player-0008', 'stock');
    a.send(ClientMsg.Transfer, { from: 'stock', slot: 0, qty: 1 });
    await room.waitForNextMessage();
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
    goTo(room, 'lab-player-0008', 'rack');
    expect((await act(a, 'rack', 'hang')).ok).toBe(true);
    let c = await act(a, 'rack', 'collect');
    while (!c.ok) {
      await new Promise((r) => setTimeout(r, 200));
      c = await act(a, 'rack', 'collect');
    }
    expect(count(bagOf(room, 'lab-player-0008'), 'plant_dried_base')).toBe(strain.freshPerPlant);

    // découper : les pochons arrivent dans le sac à la fin de la découpe
    goTo(room, 'lab-player-0008', 'table');
    expect((await act(a, 'table', 'cut')).ok).toBe(true);
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
    client.send(ClientMsg.Transfer, { from: 'stock', slot: 0, qty: 3 });
    await room.waitForNextMessage();
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
    expect(count(readInventory(p.bag), 'seed_base')).toBe(3);
    expect(readInventory(again.state.lab.stock)).toEqual(readInventory(room.state.lab.stock));

    // le joueur revient avec son playerId et retrouve tout
    await colyseus.sdk.joinById(code, { playerId: 'lab-player-0010', name: 'Chimiste' });
    expect(p.connected).toBe(true);
  });
});
