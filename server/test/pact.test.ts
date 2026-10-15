import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room as ServerRoom } from '@colyseus/core';
import type { Room as ClientRoom } from 'colyseus.js';
import {
  add,
  ClientMsg,
  count,
  emptyInventory,
  gameData,
  interactionPoint,
  ROOM_NAME,
  ServerMsg,
  type DialogueNodeMessage,
  type FixturePlaceMessage,
  type FixtureResultMessage,
  type NoticeMessage,
  type StationAction,
} from '@narco/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NarcoRoom } from '../src/rooms/NarcoRoom';
import { GameState } from '../src/rooms/schema';
import { readInventory, writeInventory } from '../src/rooms/stateSync';
import { hydrateState, RoomSnapshotSchema, SNAPSHOT_SCHEMA_VERSION } from '../src/persistence';
import { bootOn } from './helpers';

type SdkRoom = ClientRoom<GameState>;

const { economy, items } = gameData;
const SEEDS = economy.pact.startSeeds;
const SEED = economy.pact.seedItemId;
const JEFE = gameData.locations.get('repaire_jefe')!;
const strain = economy.strains.find((s) => s.id === 'base')!;

let colyseus: ColyseusTestServer;

beforeAll(async () => {
  colyseus = await bootOn(2583);
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

/** Dans la rue, devant la porte du repaire d'El Jefe. */
function atJefe(room: NarcoRoom, playerId: string) {
  const p = room.state.players.get(playerId)!;
  const at = interactionPoint(JEFE);
  Object.assign(p, { zone: 'street', x: at.x, z: at.z });
}

/** Place un joueur dans un intérieur, devant un poste fixe ou un meuble posé. */
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

async function talkToJefe(c: SdkRoom): Promise<DialogueNodeMessage> {
  c.send(ClientMsg.Interact, { locationId: JEFE.id });
  return (await c.waitForMessage(ServerMsg.Dialogue)) as DialogueNodeMessage;
}

async function choose(c: SdkRoom, dialogueId: string, nodeId: string, choiceId: string) {
  c.send(ClientMsg.DialogueChoose, { dialogueId, nodeId, choiceId });
  return (await c.waitForMessage(ServerMsg.Dialogue)) as DialogueNodeMessage;
}

/** Accepte le pacte : renvoie la notice (ok = graines reçues) et le nœud suivant. */
async function accept(c: SdkRoom) {
  c.send(ClientMsg.DialogueChoose, {
    dialogueId: 'el_jefe',
    nodeId: 'welcome',
    choiceId: 'accept',
  });
  // notice et nœud partent dans le même tick : on les attend ensemble
  const [notice, node] = (await Promise.all([
    c.waitForMessage(ServerMsg.Notice),
    c.waitForMessage(ServerMsg.Dialogue),
  ])) as [NoticeMessage, DialogueNodeMessage];
  return { notice, node };
}

async function act(c: SdkRoom, stationId: string, action: StationAction) {
  c.send(ClientMsg.Station, { stationId, action });
  return (await c.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
}

describe('pacte d’El Jefe', () => {
  it('ACTION devant le repaire : dialogue d’accueil, accepter donne les graines une seule fois', async () => {
    const id = 'pact-player-0001';
    const { client, room } = await newGame(id);
    atJefe(room, id);
    expect(await talkToJefe(client)).toEqual({
      dialogueId: 'el_jefe',
      stationId: JEFE.id,
      nodeId: 'welcome',
    });
    const { notice, node } = await accept(client);
    expect(notice.ok).toBe(true);
    expect(notice.text).toMatch(new RegExp(`\\+${SEEDS} ×`));
    expect(node.nodeId).toBe('deal');
    expect(count(bagOf(room, id), SEED)).toBe(SEEDS);
    expect(room.state.players.get(id)!.pactAccepted).toBe(true);
    expect((await choose(client, 'el_jefe', 'deal', 'end')).nodeId).toBeNull();

    // déjà conclu : rappel, pas de nouvelles graines ; « accepter » rejoué = refusé
    expect((await talkToJefe(client)).nodeId).toBe('reminder');
    client.send(ClientMsg.DialogueChoose, {
      dialogueId: 'el_jefe',
      nodeId: 'welcome',
      choiceId: 'accept',
    });
    expect(((await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage).ok).toBe(false);
    expect(count(bagOf(room, id), SEED)).toBe(SEEDS);
  });

  it('refuser puis revenir et accepter', async () => {
    const id = 'pact-player-0002';
    const { client, room } = await newGame(id);
    atJefe(room, id);
    await talkToJefe(client);
    expect((await choose(client, 'el_jefe', 'welcome', 'refuse')).nodeId).toBe('refused');
    expect((await choose(client, 'el_jefe', 'refused', 'end')).nodeId).toBeNull();
    expect(room.state.players.get(id)!.pactAccepted).toBe(false);
    expect((await talkToJefe(client)).nodeId).toBe('welcome');
    expect((await accept(client)).notice.ok).toBe(true);
    expect(count(bagOf(room, id), SEED)).toBe(SEEDS);
  });

  it('sac plein : refus propre, pacte non consommé, on peut revenir', async () => {
    const id = 'pact-player-0003';
    const { client, room } = await newGame(id);
    const p = room.state.players.get(id)!;
    const slots = gameData.economy.bag.pocketSlots;
    const full = add(emptyInventory(slots), 'scissors', slots, items); // pile de 1
    if (!full.ok) throw new Error(full.message);
    writeInventory(p.bag, full.inv);
    atJefe(room, id);
    await talkToJefe(client);
    const { notice, node } = await accept(client);
    expect(notice.ok).toBe(false);
    expect(notice.text).toMatch(/Poches pleines/);
    expect(node.nodeId).toBeNull();
    expect(p.pactAccepted).toBe(false);
    expect(count(bagOf(room, id), SEED)).toBe(0);

    writeInventory(p.bag, emptyInventory(slots));
    expect((await talkToJefe(client)).nodeId).toBe('welcome');
    expect((await accept(client)).notice.ok).toBe(true);
    expect(count(bagOf(room, id), SEED)).toBe(SEEDS);
  });

  it('deux joueurs indépendants : chacun son pacte et ses graines', async () => {
    const { client: a, room } = await newGame('pact-player-0004');
    const b = await colyseus.sdk.joinById<GameState>(room.roomId, { playerId: 'pact-player-0005' });
    atJefe(room, 'pact-player-0004');
    atJefe(room, 'pact-player-0005');
    await talkToJefe(a);
    expect((await accept(a)).notice.ok).toBe(true);
    expect(room.state.players.get('pact-player-0005')!.pactAccepted).toBe(false);
    expect((await talkToJefe(b)).nodeId).toBe('welcome');
    expect((await accept(b)).notice.ok).toBe(true);
    expect(count(bagOf(room, 'pact-player-0004'), SEED)).toBe(SEEDS);
    expect(count(bagOf(room, 'pact-player-0005'), SEED)).toBe(SEEDS);
  });

  it('trop loin ou hors de la rue : choix refusé, aucune graine', async () => {
    const id = 'pact-player-0006';
    const { client, room } = await newGame(id);
    atJefe(room, id);
    await talkToJefe(client);
    const p = room.state.players.get(id)!;
    p.x += JEFE.interactRadius + gameData.config.world.interactTolerance + 3;
    const far = await acceptRefused(client);
    expect(far.text).toMatch(/Trop loin/);
    atJefe(room, id);
    p.zone = 'shop';
    expect((await acceptRefused(client)).ok).toBe(false);
    expect(p.pactAccepted).toBe(false);
    expect(count(bagOf(room, id), SEED)).toBe(0);
  });

  it('courtier : refusé sans pacte (renvoi vers El Jefe), accepté après', async () => {
    const id = 'pact-player-0007';
    const { client, room } = await newGame(id);
    const p = room.state.players.get(id)!;
    const toBanker = () => Object.assign(p, { zone: 'bank', x: 0, z: -1.4 });
    toBanker();
    const talkBanker = async () => {
      client.send(ClientMsg.Station, { stationId: 'banker', action: 'talk' });
      return (await client.waitForMessage(ServerMsg.Dialogue)) as DialogueNodeMessage;
    };
    expect((await talkBanker()).nodeId).toBe('no_pact');
    expect((await choose(client, 'banker', 'no_pact', 'end')).nodeId).toBeNull();

    atJefe(room, id);
    await talkToJefe(client);
    await accept(client);
    toBanker();
    expect((await talkBanker()).nodeId).toBe('hello');
    expect((await choose(client, 'banker', 'hello', 'ask_account')).nodeId).toBe('references');
    expect((await choose(client, 'banker', 'references', 'jefe')).nodeId).toBe('offer');
    expect((await choose(client, 'banker', 'offer', 'accept')).nodeId).toBe('welcome');
    expect(p.hasAccount).toBe(true);
  });
});

async function acceptRefused(c: SdkRoom): Promise<NoticeMessage> {
  c.send(ClientMsg.DialogueChoose, {
    dialogueId: 'el_jefe',
    nodeId: 'welcome',
    choiceId: 'accept',
  });
  return (await c.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
}

describe('pacte — sauvegarde', () => {
  const snapOf = (player: Record<string, unknown>) =>
    RoomSnapshotSchema.parse({
      code: 'ABCD',
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      savedAt: 0,
      clock: { now: 0, scale: 1 },
      state: {
        ...new GameState().toJSON(),
        code: 'ABCD',
        players: { [String(player.id)]: player },
      },
    });
  const base = { id: 'old', name: 'Ancien', color: '#ffffff', x: 0, z: 0 };

  it('ancien snapshot sans pacte : chargé, pacte non conclu ; pacte conclu conservé', () => {
    const state = new GameState();
    hydrateState(state, snapOf(base));
    expect(state.players.get('old')!.pactAccepted).toBe(false);
    hydrateState(state, snapOf({ ...base, id: 'new', pactAccepted: true }));
    expect(state.players.get('new')!.pactAccepted).toBe(true);
  });
});

describe('partie neuve → pochons', () => {
  it('150 $ : pacte, kit et nourriture achetés, 4 graines plantées, cycle complet', async () => {
    const id = 'pact-player-0010';
    const { client, room } = await newGame(id);
    client.send(ClientMsg.Debug, { cmd: 'timeScale', scale: 60 });
    await client.waitForMessage(ServerMsg.Notice);
    const p = room.state.players.get(id)!;
    expect(room.state.players.get(id)!.cleanBalance).toBe(150);
    expect([p.hasAccount, p.cleanBalance, p.pactAccepted]).toEqual([false, 150, false]);

    // 1. le pacte : 4 graines
    atJefe(room, id);
    await talkToJefe(client);
    expect((await accept(client)).notice.ok).toBe(true);

    // 2. Bricoshop : un pot par graine, un étendoir, une table, en argent sale
    const take = async (interiorId: string, shelf: string, n = 1) => {
      goTo(room, id, interiorId, shelf);
      for (let i = 0; i < n; i++) expect((await act(client, shelf, 'take')).ok).toBe(true);
    };
    await take('shop', 'shelf_pots', SEEDS);
    await take('shop', 'shelf_racks');
    await take('shop', 'shelf_tables');
    goTo(room, id, 'shop', 'counter');
    expect((await act(client, 'counter', 'pay')).ok).toBe(true);

    // 3. labo : pose des meubles
    goTo(room, id, 'lab', 'water');
    let requestId = 1;
    const place = async (itemId: string, x: number, z: number, rot = 0) => {
      const msg: FixturePlaceMessage = { requestId: requestId++, itemId, x, z, rot };
      client.send(ClientMsg.FixturePlace, msg);
      const r = (await client.waitForMessage(ServerMsg.FixtureResult)) as FixtureResultMessage;
      expect(r.ok, r.text).toBe(true);
      return r.fixtureId!;
    };
    const potSpots = [
      [-5, -2.8],
      [-2.6, -2.8],
      [-4.6, -0.4],
      [-2.2, -0.4],
    ] as const;
    const pots: string[] = [];
    for (const [x, z] of potSpots.slice(0, SEEDS)) pots.push(await place('pot', x, z));
    const rack = await place('drying_rack', 1.8, -3.4);
    const table = await place('cutting_table', 4.4, 0.4, 1);

    // 4. épicerie : 3 articles de nourriture ou boisson, payés en propre (sans compte)
    await take('grocery', 'shelf_water');
    await take('grocery', 'shelf_food');
    await take('grocery', 'shelf_soda');
    goTo(room, id, 'grocery', 'counter');
    expect((await act(client, 'counter', 'pay')).text).toMatch(/par carte/);
    for (const it of ['water', 'food', 'soda']) expect(count(bagOf(room, id), it)).toBe(1);
    expect(count(bagOf(room, id), 'cash_dirty')).toBeGreaterThanOrEqual(0);

    // 5. plantation des 4 graines, arrosage, récolte, séchage, découpe
    const retry = async (stationId: string, action: StationAction) => {
      let n = await act(client, stationId, action);
      while (!n.ok) {
        await new Promise((r) => setTimeout(r, 150));
        n = await act(client, stationId, action);
      }
    };
    for (const pot of pots) {
      goTo(room, id, 'lab', pot);
      expect((await act(client, pot, 'plant')).ok).toBe(true);
    }
    expect(count(bagOf(room, id), SEED)).toBe(0);
    for (let i = 0; i < Math.ceil(strain.growSeconds / strain.waterEverySeconds); i++)
      for (const pot of pots) {
        goTo(room, id, 'lab', 'water');
        await act(client, 'water', 'fill');
        goTo(room, id, 'lab', pot);
        await retry(pot, 'water');
      }
    for (const pot of pots) {
      goTo(room, id, 'lab', pot);
      await retry(pot, 'harvest');
    }
    const total = SEEDS * strain.freshPerPlant;
    expect(count(bagOf(room, id), `plant_fresh_${strain.id}`)).toBe(total);
    goTo(room, id, 'lab', rack);
    while (count(bagOf(room, id), `plant_dried_${strain.id}`) < total) {
      if (count(bagOf(room, id), `plant_fresh_${strain.id}`) > 0) await act(client, rack, 'hang');
      await retry(rack, 'collect');
    }
    goTo(room, id, 'lab', table);
    while (count(bagOf(room, id), `plant_dried_${strain.id}`) > 0) {
      await retry(table, 'cut');
      await client.waitForMessage(ServerMsg.Notice); // fin de la découpe
    }
    expect(count(bagOf(room, id), `pouch_${strain.id}`)).toBe(total * strain.pouchesPerDried);
  }, 30000);
});
