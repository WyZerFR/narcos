import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room as ServerRoom } from '@colyseus/core';
import type { Room as ClientRoom } from 'colyseus.js';
import {
  ClientMsg,
  count,
  gameData,
  interactionPoint,
  ROOM_NAME,
  ServerMsg,
  type FixturePlaceMessage,
  type FixtureResultMessage,
  type NoticeMessage,
  type StationAction,
} from '@narco/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NarcoRoom } from '../src/rooms/NarcoRoom';
import { GameState } from '../src/rooms/schema';
import { readInventory, replaceBag } from '../src/rooms/stateSync';
import { hydrateState, RoomSnapshotSchema, SNAPSHOT_SCHEMA_VERSION } from '../src/persistence';
import { bootOn, frontOf, furnish } from './helpers';

type SdkRoom = ClientRoom<GameState>;

const { economy, items } = gameData;
const BAG = economy.bag;
const BACKPACK = BAG.backpackItemId;
const strain = economy.strains.find((s) => s.id === 'base')!;

let colyseus: ColyseusTestServer;

beforeAll(async () => {
  colyseus = await bootOn(2582);
});
afterAll(async () => {
  await colyseus.shutdown();
});
beforeEach(async () => {
  await colyseus.cleanup();
});

async function newGame(playerId: string) {
  const client = await colyseus.sdk.create<GameState>(ROOM_NAME, { playerId, name: 'Client' });
  const room = colyseus.getRoomById<GameState>(client.roomId) as ServerRoom<GameState> as NarcoRoom;
  return { client, room };
}

const bagOf = (room: NarcoRoom, id: string) => readInventory(room.state.players.get(id)!.bag);

/** Place un joueur devant un poste fixe ou un meuble posé. */
function goTo(room: NarcoRoom, playerId: string, interiorId: string, stationId: string) {
  const p = room.state.players.get(playerId)!;
  const furniture = room.state.lab.fixtures.get(stationId);
  const def = furniture && items.get(furniture.itemId)!.placeable!;
  const st = gameData.interiors.get(interiorId)!.stations.find((s) => s.id === stationId);
  const at = furniture
    ? { x: furniture.x, z: furniture.z + def!.d / 2 + 0.5 }
    : { x: st!.position.x, z: st!.position.z + st!.size.d / 2 + 0.5 };
  Object.assign(p, { zone: interiorId, x: at.x, z: at.z });
}

async function act(c: SdkRoom, stationId: string, action: StationAction) {
  c.send(ClientMsg.Station, { stationId, action });
  return (await c.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
}

async function useSlot(c: SdkRoom, slot: number) {
  c.send(ClientMsg.Use, { slot });
  return (await c.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
}

const slotOf = (room: NarcoRoom, id: string, itemId: string) =>
  bagOf(room, id).findIndex((s) => s?.itemId === itemId);

describe('poches et sac à dos', () => {
  it('départ : 6 poches, palier 0', async () => {
    const id = 'bag-player-0001';
    const { room } = await newGame(id);
    const p = room.state.players.get(id)!;
    expect(p.bag.length).toBe(BAG.pocketSlots);
    expect(p.bagTier).toBe(0);
  });

  it('achat au Bricoshop puis équipement (« Utiliser ») : 12 cases, objet consommé ; double équipement refusé', async () => {
    const id = 'bag-player-0002';
    const { client, room } = await newGame(id);
    const p = room.state.players.get(id)!;
    goTo(room, id, 'shop', 'shelf_bags');
    expect((await act(client, 'shelf_bags', 'take')).ok).toBe(true);
    goTo(room, id, 'shop', 'counter');
    expect((await act(client, 'counter', 'pay')).ok).toBe(true);
    expect(count(bagOf(room, id), BACKPACK)).toBe(1);
    const n = await useSlot(client, slotOf(room, id, BACKPACK));
    expect(n.ok, n.text).toBe(true);
    expect(p.bagTier).toBe(1);
    expect(p.bag.length).toBe(BAG.backpackSlots);
    expect(count(bagOf(room, id), BACKPACK)).toBe(0);
    // un second sac (debug) : refusé, l'objet reste
    client.send(ClientMsg.Debug, { cmd: 'give', itemId: BACKPACK, qty: 1 });
    await client.waitForMessage(ServerMsg.Notice);
    expect((await useSlot(client, slotOf(room, id, BACKPACK))).text).toBe('Tu portes déjà un sac.');
    expect(count(bagOf(room, id), BACKPACK)).toBe(1);
  });

  it('achat refusé poches pleines, sans rien débiter', async () => {
    const id = 'bag-player-0003';
    const { client, room } = await newGame(id);
    const p = room.state.players.get(id)!;
    // argent + 5 ciseaux (pile de 1) : les 6 poches sont pleines
    replaceBag(p.bag, [
      { itemId: 'cash_dirty', qty: 100 },
      ...Array.from({ length: 5 }, () => ({ itemId: 'scissors', qty: 1 })),
    ]);
    goTo(room, id, 'shop', 'shelf_bags');
    await act(client, 'shelf_bags', 'take');
    goTo(room, id, 'shop', 'counter');
    expect((await act(client, 'counter', 'pay')).text).toBe('Poches pleines : libère une case.');
    expect(count(bagOf(room, id), 'cash_dirty')).toBe(100);
  });

  it('pacte avec poches pleines : refus propre, pacte non consommé', async () => {
    const id = 'bag-player-0004';
    const { client, room } = await newGame(id);
    const p = room.state.players.get(id)!;
    replaceBag(
      p.bag,
      Array.from({ length: 6 }, () => ({ itemId: 'scissors', qty: 1 })),
    );
    Object.assign(p, interactionPoint(gameData.locations.get('repaire_jefe')!));
    client.send(ClientMsg.Interact, { locationId: 'repaire_jefe' });
    await client.waitForMessage(ServerMsg.Dialogue);
    client.send(ClientMsg.DialogueChoose, {
      dialogueId: 'el_jefe',
      nodeId: 'welcome',
      choiceId: 'accept',
    });
    const n = (await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
    expect(n.ok).toBe(false);
    expect(n.text).toMatch(/Poches pleines/);
    expect(p.pactAccepted).toBe(false);
  });

  it('debug : palier forcé (sans perte d’objet) et sac vidé', async () => {
    const id = 'bag-player-0005';
    const { client, room } = await newGame(id);
    const p = room.state.players.get(id)!;
    client.send(ClientMsg.Debug, { cmd: 'setBagTier', tier: 1 });
    await client.waitForMessage(ServerMsg.Notice);
    expect([p.bagTier, p.bag.length]).toEqual([1, 12]);
    expect(p.cleanBalance).toBe(economy.startingMoney.clean);
    client.send(ClientMsg.Debug, { cmd: 'clearBag' });
    await client.waitForMessage(ServerMsg.Notice);
    expect(bagOf(room, id).filter(Boolean)).toHaveLength(0);
    expect(p.bag.length).toBe(12);
  });
});

describe('messages « plein » selon le palier', () => {
  it('reprise de meuble : « Poches pleines » sans sac à dos, « Sac plein » avec', async () => {
    const id = 'bag-player-0006';
    const { client, room } = await newGame(id);
    const p = room.state.players.get(id)!;
    const [potId] = Object.values(furnish(room, ['pot_1']));
    const full = (n: number) => Array.from({ length: n }, () => ({ itemId: 'scissors', qty: 1 }));
    const pickup = async () => {
      Object.assign(p, { zone: 'lab', ...frontOf('pot_1') });
      client.send(ClientMsg.FixturePickup, { requestId: 1, fixtureId: potId });
      return (await client.waitForMessage(ServerMsg.FixtureResult)) as {
        ok: boolean;
        text: string;
      };
    };
    replaceBag(p.bag, full(BAG.pocketSlots));
    expect((await pickup()).text).toBe('Poches pleines : impossible de reprendre ce meuble.');
    p.bagTier = 1;
    replaceBag(p.bag, full(BAG.backpackSlots));
    expect((await pickup()).text).toBe('Sac plein : impossible de reprendre ce meuble.');
  });
});

describe('poches — ancienne sauvegarde', () => {
  const snap = (bag: { itemId: string; qty: number }[], bagTier?: number) =>
    RoomSnapshotSchema.parse({
      code: 'ABCD',
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      savedAt: 0,
      clock: { now: 0, scale: 1 },
      state: {
        ...new GameState().toJSON(),
        code: 'ABCD',
        players: {
          old: {
            id: 'old',
            name: 'A',
            color: '#ffffff',
            x: 0,
            z: 0,
            bag,
            ...(bagTier !== undefined ? { bagTier } : {}),
          },
        },
      },
    });
  const empty = { itemId: '', qty: 0 };

  it('10 cases, 8 piles : traité comme sac à dos (12 cases), tous les objets gardés', () => {
    const bag = [
      ...Array.from({ length: 8 }, (_, i) => ({ itemId: i % 2 ? 'food' : 'scissors', qty: 1 })),
      empty,
      empty,
    ];
    const state = new GameState();
    hydrateState(state, snap(bag));
    const p = state.players.get('old')!;
    expect([p.bagTier, p.bag.length]).toEqual([1, 12]);
    expect(count(readInventory(p.bag), 'scissors') + count(readInventory(p.bag), 'food')).toBe(8);
  });

  it('10 cases, 2 piles en fin de sac : poches de 6 cases, objets tassés et gardés', () => {
    const bag = [
      ...Array.from({ length: 8 }, () => empty),
      { itemId: 'food', qty: 3 },
      { itemId: 'water', qty: 2 },
    ];
    const state = new GameState();
    hydrateState(state, snap(bag));
    const p = state.players.get('old')!;
    expect([p.bagTier, p.bag.length]).toEqual([0, 6]);
    const inv = readInventory(p.bag);
    expect([count(inv, 'food'), count(inv, 'water')]).toEqual([3, 2]);
  });

  it('palier sauvegardé conservé', () => {
    const state = new GameState();
    hydrateState(
      state,
      snap(
        Array.from({ length: 12 }, () => empty),
        1,
      ),
    );
    expect(state.players.get('old')!.bag.length).toBe(12);
  });
});

describe('poches → pochons', () => {
  it('partie neuve : kit, sac à dos, pacte, plantation, cycle complet', async () => {
    const id = 'bag-player-0010';
    const { client, room } = await newGame(id);
    const p = room.state.players.get(id)!;
    client.send(ClientMsg.Debug, { cmd: 'timeScale', scale: 60 });
    await client.waitForMessage(ServerMsg.Notice);
    // kit minimal au Bricoshop, sac à dos à l'épicerie, avec les 150 $ de départ
    for (const shelf of ['shelf_pots', 'shelf_racks', 'shelf_tables']) {
      goTo(room, id, 'shop', shelf);
      expect((await act(client, shelf, 'take')).ok).toBe(true);
    }
    goTo(room, id, 'shop', 'counter');
    expect((await act(client, 'counter', 'pay')).ok).toBe(true);
    goTo(room, id, 'shop', 'shelf_bags');
    await act(client, 'shelf_bags', 'take');
    goTo(room, id, 'shop', 'counter');
    expect((await act(client, 'counter', 'pay')).ok).toBe(true);
    expect((await useSlot(client, slotOf(room, id, BACKPACK))).ok).toBe(true);
    expect(p.bag.length).toBe(BAG.backpackSlots);
    // pacte : les graines vont dans le sac
    Object.assign(p, {
      zone: 'street',
      ...interactionPoint(gameData.locations.get('repaire_jefe')!),
    });
    client.send(ClientMsg.Interact, { locationId: 'repaire_jefe' });
    await client.waitForMessage(ServerMsg.Dialogue);
    client.send(ClientMsg.DialogueChoose, {
      dialogueId: 'el_jefe',
      nodeId: 'welcome',
      choiceId: 'accept',
    });
    const [n] = (await Promise.all([
      client.waitForMessage(ServerMsg.Notice),
      client.waitForMessage(ServerMsg.Dialogue),
    ])) as [NoticeMessage, unknown];
    expect(n.ok, n.text).toBe(true);
    expect(count(bagOf(room, id), 'seed_base')).toBe(economy.pact.startSeeds);
    // labo : pose, plantation, arrosage, récolte, séchage, découpe
    goTo(room, id, 'lab', 'water');
    let requestId = 1;
    const place = async (itemId: string, x: number, z: number, rot = 0) => {
      const msg: FixturePlaceMessage = { requestId: requestId++, itemId, x, z, rot };
      client.send(ClientMsg.FixturePlace, msg);
      const r = (await client.waitForMessage(ServerMsg.FixtureResult)) as FixtureResultMessage;
      expect(r.ok, r.text).toBe(true);
      return r.fixtureId!;
    };
    const pot = await place('pot', -3, -2);
    const rack = await place('drying_rack', 1.8, -3.4);
    const table = await place('cutting_table', 4.4, 0.4, 1);
    const retry = async (stationId: string, action: StationAction) => {
      let r = await act(client, stationId, action);
      while (!r.ok) {
        await new Promise((res) => setTimeout(res, 150));
        r = await act(client, stationId, action);
      }
    };
    goTo(room, id, 'lab', pot);
    expect((await act(client, pot, 'plant')).ok).toBe(true);
    for (let i = 0; i < Math.ceil(strain.growSeconds / strain.waterEverySeconds); i++) {
      goTo(room, id, 'lab', 'water');
      await act(client, 'water', 'fill');
      goTo(room, id, 'lab', pot);
      await retry(pot, 'water');
    }
    await retry(pot, 'harvest');
    goTo(room, id, 'lab', rack);
    await retry(rack, 'hang');
    await retry(rack, 'collect');
    goTo(room, id, 'lab', table);
    await retry(table, 'cut');
    await client.waitForMessage(ServerMsg.Notice);
    expect(count(bagOf(room, id), 'pouch_base')).toBe(
      strain.freshPerPlant * strain.pouchesPerDried,
    );
  }, 30000);
});
