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
import { GameState, LaunderEntry } from '../src/rooms/schema';
import { readInventory, writeInventory } from '../src/rooms/stateSync';
import { hydrateState, RoomSnapshotSchema, SNAPSHOT_SCHEMA_VERSION } from '../src/persistence';
import { bootOn } from './helpers';

type SdkRoom = ClientRoom<GameState>;

const CELLAR = gameData.economy.launder.venues.cellar;
const BANK = gameData.economy.launder.venues.bank;
const TRAP = gameData.locations.get('trappe_cave')!;
/** Devant le bureau du blanchisseur, et près de l'escalier (loin de lui). */
const AT_LAUNDERER = { x: 0, z: -0.7 };
const AT_STAIRS = { x: 3.2, z: 2.2 };

let colyseus: ColyseusTestServer;

beforeAll(async () => {
  colyseus = await bootOn(2581);
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

function place(room: NarcoRoom, id: string, zone: string, at: { x: number; z: number }) {
  Object.assign(room.state.players.get(id)!, { zone, ...at });
}

function setDirty(room: NarcoRoom, id: string, cash: number) {
  const empty = emptyInventory(gameData.config.inventory.bagSlots);
  const r = cash > 0 ? add(empty, 'cash_dirty', cash, gameData.items) : null;
  writeInventory(room.state.players.get(id)!.bag, r?.ok ? r.inv : empty);
}

const dirtyOf = (room: NarcoRoom, id: string) =>
  count(readInventory(room.state.players.get(id)!.bag), 'cash_dirty');

async function talk(c: SdkRoom) {
  c.send(ClientMsg.Station, { stationId: 'launderer', action: 'talk' });
  return (await c.waitForMessage(ServerMsg.Dialogue)) as DialogueNodeMessage;
}
async function choose(c: SdkRoom, nodeId: string, choiceId: string) {
  c.send(ClientMsg.DialogueChoose, { dialogueId: 'launderer', nodeId, choiceId });
  return (await c.waitForMessage(ServerMsg.Dialogue)) as DialogueNodeMessage;
}
let requestId = 1;
async function launderAt(c: SdkRoom, amount: number, stationId = 'launderer') {
  c.send(ClientMsg.BankLaunder, { requestId: requestId++, stationId, amount });
  return (await c.waitForMessage(ServerMsg.LaunderResult)) as LaunderResultMessage;
}

describe('cave — trappe, entrée et sortie', () => {
  it('« Descendre » mène à la cave ; « Remonter » replace à côté de la trappe, dans le jardin', async () => {
    const id = 'cellar-player-0001';
    const { client, room } = await newGame(id);
    const p = room.state.players.get(id)!;
    place(room, id, 'street', interactionPoint(TRAP));
    client.send(ClientMsg.Interact, { locationId: TRAP.id });
    expect(((await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage).ok).toBe(true);
    expect(p.zone).toBe('cellar');
    place(room, id, 'cellar', AT_STAIRS);
    client.send(ClientMsg.Station, { stationId: 'exit', action: 'exit' });
    await client.waitForMessage(ServerMsg.Notice);
    expect(p.zone).toBe('street');
    const garden = gameData.quartierLayouts.get('sud')!.cellar!.garden;
    expect(
      p.x >= garden.minX && p.x <= garden.maxX && p.z >= garden.minZ && p.z <= garden.maxZ,
    ).toBe(true);
    expect(p.area).toBe('south');
  });

  it('trop loin de la trappe : refus', async () => {
    const id = 'cellar-player-0002';
    const { client, room } = await newGame(id);
    const at = interactionPoint(TRAP);
    place(room, id, 'street', { x: at.x + 5, z: at.z });
    client.send(ClientMsg.Interact, { locationId: TRAP.id });
    expect(((await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage).text).toMatch(
      /Trop loin/,
    );
  });
});

describe('cave — dialogue du blanchisseur', () => {
  it('sans compte : « Pas de compte, pas de lessive. »', async () => {
    const id = 'cellar-player-0010';
    const { client, room } = await newGame(id);
    place(room, id, 'cellar', AT_LAUNDERER);
    expect((await talk(client)).nodeId).toBe('hello');
    expect((await choose(client, 'hello', 'ask_no_account')).nodeId).toBe('no_account');
  });

  it('avec compte : flux complet, « Je veux blanchir » ouvre le panneau du lieu cellar', async () => {
    const id = 'cellar-player-0011';
    const { client, room } = await newGame(id);
    room.state.players.get(id)!.hasAccount = true;
    place(room, id, 'cellar', AT_LAUNDERER);
    await talk(client);
    expect((await choose(client, 'hello', 'ask')).nodeId).toBe('offer');
    client.send(ClientMsg.DialogueChoose, {
      dialogueId: 'launderer',
      nodeId: 'offer',
      choiceId: 'launder',
    });
    const [node, open] = (await Promise.all([
      client.waitForMessage(ServerMsg.Dialogue),
      client.waitForMessage(ServerMsg.LaunderOpen),
    ])) as [DialogueNodeMessage, LaunderOpenMessage];
    expect(node.nodeId).toBeNull();
    expect(open).toEqual({ stationId: 'launderer', venue: 'cellar' });
  });
});

describe('cave — blanchiment à 15 %', () => {
  it('net = montant × (1 − 15 %), commission arrondie au dollar supérieur ; événement', async () => {
    const id = 'cellar-player-0020';
    const { client, room } = await newGame(id);
    const me = room.state.players.get(id)!;
    me.hasAccount = true;
    setDirty(room, id, 500);
    place(room, id, 'cellar', AT_LAUNDERER);
    const events: LaunderedEvent[] = [];
    room.events.on(LAUNDERED, (e: LaunderedEvent) => events.push(e));
    const r = await launderAt(client, 101);
    expect(r.ok, r.text).toBe(true);
    const { commission, net } = launderSplit(101, CELLAR.fee);
    expect(commission).toBe(16); // 15,15 → 16
    expect(net).toBe(85);
    expect(me.cleanBalance).toBe(85);
    expect(dirtyOf(room, id)).toBe(399);
    expect(me.cellarLaunderLog.map((e) => e.amount)).toEqual([101]);
    expect(me.launderLog.length).toBe(0);
    expect(events).toEqual([
      { playerId: id, dirty: 101, clean: 85, venue: 'cellar', area: 'south' },
    ]);
  });

  it('refus : sans compte, sans argent, au-delà du plafond, mauvaise zone, trop loin', async () => {
    const id = 'cellar-player-0021';
    const { client, room } = await newGame(id);
    const me = room.state.players.get(id)!;
    place(room, id, 'cellar', AT_LAUNDERER);
    setDirty(room, id, 100);
    expect((await launderAt(client, 50)).text).toBe("Ouvre d'abord un compte à la banque.");
    me.hasAccount = true;
    setDirty(room, id, 0);
    expect((await launderAt(client, 50)).text).toMatch(/pas d'argent sale/);
    setDirty(room, id, CELLAR.cap + 500);
    expect((await launderAt(client, CELLAR.cap + 1)).text).toMatch(/Plafond atteint/);
    place(room, id, 'cellar', AT_STAIRS);
    expect((await launderAt(client, 50)).text).toMatch(/Trop loin/);
    place(room, id, 'bank', { x: 0, z: 0 });
    expect((await launderAt(client, 50)).text).toMatch(/pas ici/);
    expect(me.cleanBalance).toBe(0);
  });

  it('plafond glissant séparé de celui de la banque', async () => {
    const id = 'cellar-player-0022';
    const { client, room } = await newGame(id);
    const me = room.state.players.get(id)!;
    me.hasAccount = true;
    setDirty(room, id, 10_000);
    // banque saturée : la cave reste disponible
    me.launderLog.push(Object.assign(new LaunderEntry(), { at: room.now(), amount: BANK.cap }));
    place(room, id, 'cellar', AT_LAUNDERER);
    expect((await launderAt(client, CELLAR.cap)).ok).toBe(true);
    expect((await launderAt(client, 1)).text).toMatch(/Plafond atteint/);
    // fenêtre de la cave écoulée : de nouveau possible
    for (const e of me.cellarLaunderLog) e.at = room.now() - CELLAR.windowSeconds * 1000 - 1;
    expect((await launderAt(client, 100)).ok).toBe(true);
    // la banque, elle, reste pleine
    place(room, id, 'bank', { x: -3.2, z: 1.6 });
    expect((await launderAt(client, 1, 'teller_1')).text).toMatch(/Plafond atteint/);
  });

  it('debug : plafond de la cave remis à zéro, commission réglée à chaud', async () => {
    const id = 'cellar-player-0023';
    const { client, room } = await newGame(id);
    const me = room.state.players.get(id)!;
    me.cellarLaunderLog.push(Object.assign(new LaunderEntry(), { at: room.now(), amount: 1 }));
    me.launderLog.push(Object.assign(new LaunderEntry(), { at: room.now(), amount: 1 }));
    client.send(ClientMsg.Debug, { cmd: 'resetLaunderCap', venue: 'cellar' });
    await client.waitForMessage(ServerMsg.Notice);
    expect([me.cellarLaunderLog.length, me.launderLog.length]).toEqual([0, 1]);
    const before = CELLAR.fee;
    client.send(ClientMsg.Debug, { cmd: 'launderFee', venue: 'cellar', value: 0.2 });
    expect(((await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage).ok).toBe(true);
    expect(CELLAR.fee).toBe(0.2);
    client.send(ClientMsg.Debug, { cmd: 'launderFee', venue: 'cellar', value: 1.5 });
    expect(((await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage).ok).toBe(false);
    CELLAR.fee = before;
    client.send(ClientMsg.Debug, { cmd: 'teleportTrapdoor' });
    await client.waitForMessage(ServerMsg.Notice);
    expect({ x: me.x, z: me.z }).toEqual(interactionPoint(TRAP));
  });

  it('ancienne sauvegarde sans journal de cave : chargée, journal vide', () => {
    const snap = RoomSnapshotSchema.parse({
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
            launderLog: [{ at: 5, amount: 10 }],
          },
        },
      },
    });
    const state = new GameState();
    hydrateState(state, snap);
    const p = state.players.get('old')!;
    expect(p.launderLog.length).toBe(1);
    expect(p.cellarLaunderLog.length).toBe(0);
  });
});

describe('cave — parcours complet', () => {
  it('vente de rue, compte ouvert, descente à la cave, blanchiment à 15 %, solde correct', async () => {
    const id = 'cellar-player-0030';
    const { client, room } = await newGame(id);
    const me = room.state.players.get(id)!;
    let inv = emptyInventory(gameData.config.inventory.bagSlots);
    const r = add(inv, 'pouch_base', 3, gameData.items);
    if (r.ok) inv = r.inv;
    writeInventory(me.bag, inv);
    // vente de rue (acheteur de debug devant le joueur)
    place(room, id, 'street', gameData.config.players.spawn);
    client.send(ClientMsg.Debug, { cmd: 'spawnBuyer' });
    const n = (await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
    const npc = [...room.state.npcs.values()].find((x) => n.text.includes(x.name))!;
    client.send(ClientMsg.SaleOpen, { npcId: npc.id });
    const offer = (await client.waitForMessage(ServerMsg.SaleOffer)) as SaleOfferMessage;
    client.send(ClientMsg.SaleAccept, { npcId: npc.id, qty: offer.maxQty });
    expect(((await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage).ok).toBe(true);
    const earned = offer.maxQty * offer.unitPrice;
    const dirty = dirtyOf(room, id);
    expect(dirty).toBe(earned); // sac de départ remplacé par les pochons
    // compte ouvert chez M. Lenoir (pacte conclu)
    me.pactAccepted = true;
    place(room, id, 'bank', { x: 0, z: -1.4 });
    client.send(ClientMsg.Station, { stationId: 'banker', action: 'talk' });
    await client.waitForMessage(ServerMsg.Dialogue);
    for (const [node, choice] of [
      ['hello', 'ask_account'],
      ['references', 'jefe'],
      ['offer', 'accept'],
    ] as const) {
      client.send(ClientMsg.DialogueChoose, {
        dialogueId: 'banker',
        nodeId: node,
        choiceId: choice,
      });
      await client.waitForMessage(ServerMsg.Dialogue);
    }
    expect(me.hasAccount).toBe(true);
    // descente à la cave par la trappe, puis blanchiment de tout l'argent sale
    place(room, id, 'street', interactionPoint(TRAP));
    client.send(ClientMsg.Interact, { locationId: TRAP.id });
    await client.waitForMessage(ServerMsg.Notice);
    expect(me.zone).toBe('cellar');
    place(room, id, 'cellar', AT_LAUNDERER);
    const res = await launderAt(client, dirty);
    expect(res.ok, res.text).toBe(true);
    expect(me.cleanBalance).toBe(launderSplit(dirty, CELLAR.fee).net);
    expect(dirtyOf(room, id)).toBe(0);
  });
});
