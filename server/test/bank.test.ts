import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room as ServerRoom } from '@colyseus/core';
import type { Room as ClientRoom } from 'colyseus.js';
import {
  ClientMsg,
  ROOM_NAME,
  ServerMsg,
  type DialogueNodeMessage,
  type NoticeMessage,
} from '@narco/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NarcoRoom } from '../src/rooms/NarcoRoom';
import type { GameState } from '../src/rooms/schema';
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
