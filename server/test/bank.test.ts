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
  LAUNDERED,
  launderSplit,
  ROOM_NAME,
  ServerMsg,
  type DialogueNodeMessage,
  type LaunderedEvent,
  type LaunderOpenMessage,
  type LaunderResultMessage,
  type NoticeMessage,
  type SaleOfferMessage,
} from '@narco/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NarcoRoom } from '../src/rooms/NarcoRoom';
import { GameState, LaunderEntry, Player } from '../src/rooms/schema';
import { readInventory, writeInventory } from '../src/rooms/stateSync';
import { freezeLaunderWindows } from '../src/rooms/bank';
import { hydrateState, RoomSnapshotSchema, SNAPSHOT_SCHEMA_VERSION } from '../src/persistence';
import { bootOn } from './helpers';

type SdkRoom = ClientRoom<GameState>;

/** Devant le comptoir du courtier, et loin de lui (près de la porte). */
const AT_BANKER = { x: 0, z: -1.4 };
const AT_DOOR = { x: 0, z: 2.8 };

let colyseus: ColyseusTestServer;

beforeAll(async () => {
  colyseus = await bootOn(2578);
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
  standAt(room, playerId, AT_BANKER);
  room.state.players.get(playerId)!.pactAccepted = true; // le courtier exige le pacte (pact.test.ts)
  return { client, room };
}

function standAt(room: NarcoRoom, playerId: string, at: { x: number; z: number }, zone = 'bank') {
  const p = room.state.players.get(playerId)!;
  p.zone = zone;
  p.x = at.x;
  p.z = at.z;
}

async function talk(c: SdkRoom): Promise<DialogueNodeMessage> {
  c.send(ClientMsg.Station, { stationId: 'banker', action: 'talk' });
  return (await c.waitForMessage(ServerMsg.Dialogue)) as DialogueNodeMessage;
}
async function choose(c: SdkRoom, nodeId: string, choiceId: string) {
  c.send(ClientMsg.DialogueChoose, { dialogueId: 'banker', nodeId, choiceId });
  return (await c.waitForMessage(ServerMsg.Dialogue)) as DialogueNodeMessage;
}
async function chooseRefused(c: SdkRoom, nodeId: string, choiceId: string) {
  c.send(ClientMsg.DialogueChoose, { dialogueId: 'banker', nodeId, choiceId });
  return (await c.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
}

/** Va jusqu'à l'offre du courtier (compte non ouvert). */
async function toOffer(c: SdkRoom) {
  expect((await talk(c)).nodeId).toBe('hello');
  expect((await choose(c, 'hello', 'ask_account')).nodeId).toBe('references');
  expect((await choose(c, 'references', 'jefe')).nodeId).toBe('offer');
}

describe('banque — dialogue du courtier', () => {
  it('refuser puis revenir et accepter : compte ouvert une seule fois', async () => {
    const { client, room } = await newGame('bank-player-0001');
    const me = () => room.state.players.get('bank-player-0001')!;
    await toOffer(client);
    expect((await choose(client, 'offer', 'refuse')).nodeId).toBe('refused');
    expect((await choose(client, 'refused', 'end')).nodeId).toBeNull();
    expect(me().hasAccount).toBe(false);
    await toOffer(client);
    expect((await choose(client, 'offer', 'accept')).nodeId).toBe('welcome');
    expect(me().hasAccount).toBe(true);
    expect((await choose(client, 'welcome', 'end')).nodeId).toBeNull();
    // compte ouvert : le courtier le rappelle, plus d'ouverture possible
    expect((await talk(client)).nodeId).toBe('already_open');
    expect((await chooseRefused(client, 'hello', 'ask_account')).text).toMatch(/terminée/);
  });

  it('choix interdit par ses conditions : refusé, rien ne change', async () => {
    const { client, room } = await newGame('bank-player-0002');
    await toOffer(client);
    room.state.players.get('bank-player-0002')!.hasAccount = true;
    expect((await chooseRefused(client, 'offer', 'accept')).text).toMatch(/ne tient plus/);
  });

  it('trop loin du courtier, mauvaise zone, conversation non commencée : refus', async () => {
    const { client, room } = await newGame('bank-player-0003');
    expect((await chooseRefused(client, 'hello', 'ask_account')).text).toMatch(/terminée/);
    expect((await talk(client)).nodeId).toBe('hello');
    standAt(room, 'bank-player-0003', AT_DOOR);
    expect((await chooseRefused(client, 'hello', 'ask_account')).text).toMatch(/Trop loin/);
    standAt(room, 'bank-player-0003', { x: 0, z: 0 }, 'grocery');
    expect((await chooseRefused(client, 'hello', 'ask_account')).text).toMatch(/plus au comptoir/);
    // parler depuis la rue : le poste n'est pas là
    standAt(room, 'bank-player-0003', { x: 26, z: -6 }, 'street');
    client.send(ClientMsg.Station, { stationId: 'banker', action: 'talk' });
    const n = (await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
    expect(n.text).toMatch(/pas ici/);
    expect(room.state.players.get('bank-player-0003')!.hasAccount).toBe(false);
  });
});

// ---------------------------------------------------------------- blanchiment

const RULES = gameData.economy.launder.venues.bank;
const AT_TELLER_1 = { x: -3.2, z: 1.6 };

async function openTeller(c: SdkRoom, stationId = 'teller_1') {
  c.send(ClientMsg.Station, { stationId, action: 'launder' });
  return Promise.race([
    c.waitForMessage(ServerMsg.LaunderOpen).then((m) => ({ open: m as LaunderOpenMessage })),
    c.waitForMessage(ServerMsg.Notice).then((m) => ({ notice: m as NoticeMessage })),
  ]);
}
let nextRequest = 1;
async function launderAt(c: SdkRoom, amount: number, stationId = 'teller_1') {
  const requestId = nextRequest++;
  c.send(ClientMsg.BankLaunder, { requestId, stationId, amount });
  const r = (await c.waitForMessage(ServerMsg.LaunderResult)) as LaunderResultMessage;
  expect(r.requestId).toBe(requestId);
  return r;
}
const dirtyOf = (room: NarcoRoom, id: string) =>
  count(readInventory(room.state.players.get(id)!.bag), 'cash_dirty');

describe('banque — blanchiment au guichet', () => {
  it('sans compte : guichet refusé ; avec compte : sale retiré, net crédité, événement', async () => {
    const id = 'bank-player-0010';
    const { client, room } = await newGame(id);
    standAt(room, id, AT_TELLER_1);
    expect(await openTeller(client)).toEqual({
      notice: expect.objectContaining({ text: "Ouvrez d'abord un compte." }),
    });
    expect((await launderAt(client, 100)).text).toBe("Ouvrez d'abord un compte.");
    const me = room.state.players.get(id)!;
    me.hasAccount = true;
    expect(await openTeller(client)).toEqual({ open: { stationId: 'teller_1', venue: 'bank' } });
    const events: LaunderedEvent[] = [];
    room.events.on(LAUNDERED, (e: LaunderedEvent) => events.push(e));
    const before = dirtyOf(room, id);
    const r = await launderAt(client, 101);
    expect(r.ok, r.text).toBe(true);
    const { net } = launderSplit(101, RULES.fee);
    expect(net).toBe(Math.floor(101 * (1 - RULES.fee)));
    expect(dirtyOf(room, id)).toBe(before - 101);
    expect(me.cleanBalance).toBe(net);
    expect(events).toEqual([
      { playerId: id, dirty: 101, clean: net, venue: 'bank', area: 'street' },
    ]);
    expect(me.launderLog.map((e) => e.amount)).toEqual([101]);
  });

  it('refus : plus que le sac, sans argent, trop loin, mauvaise zone, plafond', async () => {
    const id = 'bank-player-0011';
    const { client, room } = await newGame(id);
    const me = room.state.players.get(id)!;
    me.hasAccount = true;
    standAt(room, id, AT_TELLER_1);
    const dirty = dirtyOf(room, id);
    expect((await launderAt(client, dirty + 1)).text).toMatch(/que \d+ \$/);
    standAt(room, id, AT_BANKER);
    expect((await launderAt(client, 10)).text).toMatch(/Trop loin/);
    standAt(room, id, AT_TELLER_1, 'grocery');
    expect((await launderAt(client, 10)).text).toMatch(/pas ici/);
    standAt(room, id, AT_TELLER_1);
    // plafond presque atteint sur la fenêtre
    const now = room.now();
    me.launderLog.push(Object.assign(new LaunderEntry(), { at: now, amount: RULES.cap - 50 }));
    expect((await launderAt(client, 100)).text).toMatch(/encore 50 \$/);
    expect((await launderAt(client, 50)).ok).toBe(true);
    // fenêtre glissante : les entrées anciennes ne comptent plus
    for (const e of me.launderLog) e.at = room.now() - RULES.windowSeconds * 1000 - 1;
    expect((await launderAt(client, 100)).ok).toBe(true);
    expect(me.launderLog.map((e) => e.amount)).toEqual([100]);
    // plus d'argent sale
    writeInventory(me.bag, emptyInventory(gameData.config.inventory.bagSlots));
    expect((await launderAt(client, 10)).text).toMatch(/pas d'argent sale/);
    expect(me.cleanBalance).toBe(
      launderSplit(50, RULES.fee).net + launderSplit(100, RULES.fee).net,
    );
  });

  it('fenêtre gelée sans joueur connecté : le journal est décalé du temps vide', () => {
    const state = new GameState();
    const p = new Player();
    p.launderLog.push(Object.assign(new LaunderEntry(), { at: 1000, amount: 300 }));
    state.players.set('x', p);
    freezeLaunderWindows(state, 5000);
    expect(p.launderLog.at(0)!.toJSON()).toEqual({ at: 6000, amount: 300 });
  });
});

describe('banque — sauvegarde', () => {
  const oldPlayer = { id: 'old', name: 'Ancien', color: '#e63946', x: 0, z: 0, cleanMoney: 12 };
  const snapOf = (player: { id: string }) =>
    RoomSnapshotSchema.parse({
      code: 'ABCD',
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      savedAt: 0,
      clock: { now: 0, scale: 1 },
      state: { ...new GameState().toJSON(), code: 'ABCD', players: { [player.id]: player } },
    });

  it('ancienne sauvegarde sans compte : se charge, compte fermé, solde repris', () => {
    const state = new GameState();
    hydrateState(state, snapOf(oldPlayer));
    const p = state.players.get('old')!;
    expect(p.hasAccount).toBe(false);
    expect(p.cleanBalance).toBe(12);
    expect(p.launderLog.length).toBe(0);
  });

  it('compte, solde et journal survivent au snapshot', () => {
    const state = new GameState();
    const player = {
      ...oldPlayer,
      id: 'new',
      hasAccount: true,
      cleanBalance: 450,
      launderLog: [{ at: 99, amount: 900 }],
    };
    hydrateState(state, snapOf(player));
    expect(state.players.get('new')!.toJSON()).toMatchObject({
      hasAccount: true,
      cleanBalance: 450,
      launderLog: [{ at: 99, amount: 900 }],
    });
  });
});

describe('banque — parcours complet', () => {
  it('vente de rue, entrée à la banque, ouverture du compte, blanchiment, solde correct', async () => {
    const id = 'bank-player-0020';
    const { client, room } = await newGame(id);
    const me = room.state.players.get(id)!;
    let inv = emptyInventory(gameData.config.inventory.bagSlots);
    const r = add(inv, 'pouch_base', 3, gameData.items);
    if (r.ok) inv = r.inv;
    writeInventory(me.bag, inv);
    standAt(room, id, gameData.config.players.spawn, 'street');
    // vente de rue
    client.send(ClientMsg.Debug, { cmd: 'spawnBuyer' });
    const spawned = (await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
    expect(spawned.ok, spawned.text).toBe(true);
    const npc = [...room.state.npcs.values()].find((x) => spawned.text.includes(x.name))!;
    client.send(ClientMsg.SaleOpen, { npcId: npc.id });
    const offer = (await client.waitForMessage(ServerMsg.SaleOffer)) as SaleOfferMessage;
    client.send(ClientMsg.SaleAccept, { npcId: npc.id, qty: offer.maxQty });
    expect(((await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage).ok).toBe(true);
    const earned = offer.maxQty * offer.unitPrice;
    expect(dirtyOf(room, id)).toBe(earned);
    // entrée à la banque
    standAt(room, id, interactionPoint(gameData.locations.get('banque')!), 'street');
    client.send(ClientMsg.Interact, { locationId: 'banque' });
    expect(((await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage).ok).toBe(true);
    expect(me.zone).toBe('bank');
    // ouverture du compte
    standAt(room, id, AT_BANKER);
    await toOffer(client);
    expect((await choose(client, 'offer', 'accept')).nodeId).toBe('welcome');
    // blanchiment de tout
    standAt(room, id, AT_TELLER_1);
    expect((await launderAt(client, earned)).ok).toBe(true);
    expect(dirtyOf(room, id)).toBe(0);
    expect(me.cleanBalance).toBe(
      gameData.economy.startingMoney.clean + launderSplit(earned, RULES.fee).net,
    );
  });
});
