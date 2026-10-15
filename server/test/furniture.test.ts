import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room as ServerRoom } from '@colyseus/core';
import type { Room as ClientRoom } from 'colyseus.js';
import {
  ClientMsg,
  ROOM_NAME,
  ServerMsg,
  count,
  gameData,
  LAMP_IN_USE,
  NO_LAMP,
  potGrowMs,
  type FixtureResultMessage,
  type NoticeMessage,
} from '@narco/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NarcoRoom } from '../src/rooms/NarcoRoom';
import { RackEntry, type GameState } from '../src/rooms/schema';
import { readInventory, readPot } from '../src/rooms/stateSync';
import { spawnFurniture } from '../src/rooms/furniture';
import { bootOn } from './helpers';

type SdkRoom = ClientRoom<GameState>;

const lab = gameData.interiors.get('lab')!;
const strain = gameData.economy.strains.find((s) => s.id === 'base')!;
const LAMP = gameData.economy.lab.lamp;
const MAX = gameData.economy.lab.furniture.maxPerType;
/** Devant le robinet : loin des positions de pose utilisées ici. */
const NEAR_WATER = { x: -6.3, z: 2.4 };

let colyseus: ColyseusTestServer;
let nextRequest = 1;

beforeAll(async () => {
  colyseus = await bootOn(2576);
});
afterAll(async () => {
  await colyseus.shutdown();
});
beforeEach(async () => {
  await colyseus.cleanup();
});

async function newGame(playerId: string) {
  const client = await colyseus.sdk.create<GameState>(ROOM_NAME, { playerId, name: 'Bricoleur' });
  const room = colyseus.getRoomById<GameState>(client.roomId) as ServerRoom<GameState> as NarcoRoom;
  standAt(room, playerId, NEAR_WATER);
  return { client, room };
}

function standAt(room: NarcoRoom, playerId: string, at: { x: number; z: number }, zone = 'lab') {
  const p = room.state.players.get(playerId)!;
  p.zone = zone;
  p.x = at.x;
  p.z = at.z;
}

async function result(client: SdkRoom, type: string, body: object): Promise<FixtureResultMessage> {
  const requestId = nextRequest++;
  client.send(type, { requestId, ...body });
  const r = (await client.waitForMessage(ServerMsg.FixtureResult)) as FixtureResultMessage;
  expect(r.requestId).toBe(requestId);
  return r;
}
const place = (c: SdkRoom, itemId: string, x: number, z: number, rot = 0) =>
  result(c, ClientMsg.FixturePlace, { itemId, x, z, rot });
const move = (c: SdkRoom, fixtureId: string, x: number, z: number, rot = 0) =>
  result(c, ClientMsg.FixtureMove, { fixtureId, x, z, rot });
const pickup = (c: SdkRoom, fixtureId: string) => result(c, ClientMsg.FixturePickup, { fixtureId });
async function give(c: SdkRoom, itemId: string, qty = 1) {
  c.send(ClientMsg.Debug, { cmd: 'give', itemId, qty });
  await c.waitForMessage(ServerMsg.Notice);
}
async function station(c: SdkRoom, stationId: string, action: string) {
  c.send(ClientMsg.Station, { stationId, action });
  return (await c.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
}
const bagCount = (room: NarcoRoom, id: string, itemId: string) =>
  count(readInventory(room.state.players.get(id)!.bag), itemId);

describe('labo — poser un meuble', () => {
  it('pose un objet du sac où l’on veut : retiré du sac, état de production créé', async () => {
    const { client, room } = await newGame('fur-player-0001');
    await give(client, 'pot');
    await give(client, 'cutting_table');
    const r = await place(client, 'pot', 0, 0);
    expect(r).toMatchObject({ ok: true, fixtureId: 'f1' });
    expect(bagCount(room, 'fur-player-0001', 'pot')).toBe(0);
    expect(room.state.lab.fixtures.get('f1')!.toJSON()).toEqual({
      itemId: 'pot',
      x: 0,
      z: 0,
      rot: 0,
    });
    expect(room.state.lab.pots.has('f1')).toBe(true);
    const t = await place(client, 'cutting_table', 4.4, 0, 1);
    expect(t.ok, t.text).toBe(true);
    expect(room.state.lab.cuts.has(t.fixtureId!)).toBe(true);
    expect(room.state.lab.fixtures.get(t.fixtureId!)!.rot).toBe(1);
  });

  it('refus clairs : hors labo, sans objet, mur, porte, robinet, meuble, joueur dessus', async () => {
    const { client, room } = await newGame('fur-player-0002');
    await give(client, 'pot');
    standAt(room, 'fur-player-0002', { x: 0, z: 0 }, 'street');
    expect((await place(client, 'pot', 0, 0)).text).toBe('À poser dans ton labo.');
    standAt(room, 'fur-player-0002', NEAR_WATER);
    expect((await place(client, 'drying_rack', 0, 0)).text).toMatch(/pas cet objet/);
    expect((await place(client, 'pot', 6.8, 0)).text).toMatch(/dépasse du mur/);
    expect((await place(client, 'pot', 0, 3.8)).text).toMatch(/porte/);
    expect((await place(client, 'pot', -6, 1.2)).text).toMatch(/Point d'eau/);
    expect((await place(client, 'pot', NEAR_WATER.x + 0.6, NEAR_WATER.z)).ok).toBe(false);
    const b = await colyseus.sdk.joinById<GameState>(room.roomId, { playerId: 'fur-player-0003' });
    standAt(room, 'fur-player-0003', { x: 2, z: 0 });
    expect((await place(client, 'pot', 2, 0)).text).toMatch(/passage/);
    expect((await place(client, 'pot', 0, -3)).ok).toBe(true);
    await give(client, 'pot');
    expect((await place(client, 'pot', 0.5, -3)).text).toMatch(/Pot de terre/);
    // tout refus laisse l'objet dans le sac
    expect(bagCount(room, 'fur-player-0002', 'pot')).toBe(1);
    await b.leave();
  });

  it('plafond par type : le meuble de trop est refusé', async () => {
    const { client, room } = await newGame('fur-player-0004');
    let n = 0;
    // rangées de pots collés (règle des écarts : collé ou ≥ 1 m), la première contre le mur
    for (const z of [-4.4, -3.2])
      for (const x of [-6.4, -5.2, -4, -2.8, -1.6, -0.4]) {
        if (n++ >= MAX.pot) break;
        expect('id' in spawnFurniture(room.state, lab, { itemId: 'pot', x, z, rot: 0 }, 0)).toBe(
          true,
        );
      }
    expect(room.state.lab.pots.size).toBe(MAX.pot);
    await give(client, 'pot');
    expect((await place(client, 'pot', 4.5, 1)).text).toMatch(`Maximum ${MAX.pot}`);
    await give(client, 'grow_lamp');
    expect((await place(client, 'grow_lamp', -5.6, -4)).ok).toBe(true); // au-dessus d'un pot
  });

  it('concurrence : deux joueurs posent au même endroit, un seul gagne', async () => {
    const { client: a, room } = await newGame('fur-player-0005');
    const b = await colyseus.sdk.joinById<GameState>(room.roomId, { playerId: 'fur-player-0006' });
    standAt(room, 'fur-player-0006', { x: -6.3, z: 3.6 });
    await give(a, 'pot');
    await give(b, 'pot');
    a.send(ClientMsg.FixturePlace, { requestId: 501, itemId: 'pot', x: 1, z: -1, rot: 0 });
    b.send(ClientMsg.FixturePlace, { requestId: 502, itemId: 'pot', x: 1.3, z: -1, rot: 0 });
    const results = (await Promise.all([
      a.waitForMessage(ServerMsg.FixtureResult),
      b.waitForMessage(ServerMsg.FixtureResult),
    ])) as FixtureResultMessage[];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)!.text).toMatch(/Ça touche/);
    expect(room.state.lab.fixtures.size).toBe(1);
    expect(
      bagCount(room, 'fur-player-0005', 'pot') + bagCount(room, 'fur-player-0006', 'pot'),
    ).toBe(1);
  });
});

describe('labo — déplacer et reprendre', () => {
  it('déplacer : l’état de production suit, les postes marchent à la nouvelle position', async () => {
    const { client, room } = await newGame('fur-player-0007');
    await give(client, 'pot');
    await give(client, 'seed_base');
    await give(client, 'grow_lamp', 2);
    const id = (await place(client, 'pot', -3, -2)).fixtureId!;
    // une lampe à l'ancienne place, une à la nouvelle : le pot planté reste éclairé
    await place(client, 'grow_lamp', -3, -2);
    await place(client, 'grow_lamp', 3, -3);
    standAt(room, 'fur-player-0007', { x: -3, z: -0.9 });
    expect((await station(client, id, 'plant')).ok).toBe(true);
    const before = room.state.lab.pots.get(id)!.toJSON();
    standAt(room, 'fur-player-0007', NEAR_WATER);
    const r = await move(client, id, 3, -3, 1);
    expect(r.ok, r.text).toBe(true);
    expect(room.state.lab.fixtures.get(id)!.toJSON()).toMatchObject({ x: 3, z: -3, rot: 1 });
    expect(room.state.lab.pots.get(id)!.toJSON()).toEqual(before);
    // l'ancienne place est trop loin, la nouvelle répond
    standAt(room, 'fur-player-0007', { x: -3, z: -0.9 });
    expect((await station(client, id, 'harvest')).text).toMatch(/Trop loin/);
    standAt(room, 'fur-player-0007', { x: 3, z: -1.9 });
    expect((await station(client, id, 'harvest')).text).not.toMatch(/Trop loin/);
    // position invalide : rien ne bouge
    expect((await move(client, id, 0, 3.8)).ok).toBe(false);
    expect(room.state.lab.fixtures.get(id)!.x).toBe(3);
    expect((await move(client, 'f99', 0, 0)).text).toMatch(/plus là/);
  });

  it('glisser : lampe déplacée au-dessus d’un pot acceptée, pot sur pot et lampe sur lampe refusés', async () => {
    const { client, room } = await newGame('fur-player-0010');
    await give(client, 'pot', 2);
    await give(client, 'grow_lamp', 2);
    const potA = (await place(client, 'pot', -3, -2)).fixtureId!;
    const potB = (await place(client, 'pot', 3, -2)).fixtureId!;
    const lampA = (await place(client, 'grow_lamp', 0, -3)).fixtureId!;
    const lampB = (await place(client, 'grow_lamp', 0, 1)).fixtureId!;
    expect((await move(client, lampA, -3, -2)).ok).toBe(true);
    expect((await move(client, potB, -2.6, -2)).text).toMatch(/Ça touche/);
    expect((await move(client, lampB, -3, -2)).text).toMatch(/Ça touche/);
    expect(room.state.lab.fixtures.get(potB)!.x).toBe(3);
    expect(room.state.lab.fixtures.get(lampB)!.z).toBe(1);
    expect(room.state.lab.fixtures.get(potA)!.x).toBe(-3);
  });

  it('déplacer est refusé si un autre joueur utilise le poste', async () => {
    const { client, room } = await newGame('fur-player-0008');
    const b = await colyseus.sdk.joinById<GameState>(room.roomId, { playerId: 'fur-player-0009' });
    await give(client, 'cutting_table');
    const id = (await place(client, 'cutting_table', 3, -2)).fixtureId!;
    standAt(room, 'fur-player-0009', { x: 3, z: -0.8 });
    const r = await move(client, id, 3, -4.4);
    expect(r).toMatchObject({ ok: false });
    expect(r.text).toMatch(/utilise ce poste/);
    standAt(room, 'fur-player-0009', { x: -6.3, z: 3.6 });
    expect((await move(client, id, 3, -4.4)).ok).toBe(true);
    await b.leave();
  });

  it('reprendre : refus pot planté, étendoir chargé, découpe en cours, trop loin ; sinon au sac', async () => {
    const { client, room } = await newGame('fur-player-0010');
    for (const it of ['pot', 'drying_rack', 'cutting_table']) await give(client, it);
    const pot = (await place(client, 'pot', -3, -2)).fixtureId!;
    const rack = (await place(client, 'drying_rack', 2, -4.6)).fixtureId!; // contre le mur
    const table = (await place(client, 'cutting_table', 4.4, 0, 1)).fixtureId!;
    expect((await pickup(client, pot)).text).toMatch(/Trop loin/);
    standAt(room, 'fur-player-0010', { x: -3, z: -0.9 });
    room.state.lab.pots.get(pot)!.planted = true;
    expect((await pickup(client, pot)).text).toMatch(/plante/);
    room.state.lab.pots.get(pot)!.planted = false;
    expect((await pickup(client, pot)).ok).toBe(true);
    expect(bagCount(room, 'fur-player-0010', 'pot')).toBe(1);
    expect(room.state.lab.pots.has(pot)).toBe(false);

    standAt(room, 'fur-player-0010', { x: 2, z: -3.7 });
    room.state.lab.racks
      .get(rack)!
      .entries.push(Object.assign(new RackEntry(), { strainId: 'base', qty: 1, readyAt: 1e12 }));
    expect((await pickup(client, rack)).text).toMatch(/chargé/);
    room.state.lab.racks.get(rack)!.entries.clear();
    expect((await pickup(client, rack)).ok).toBe(true);

    standAt(room, 'fur-player-0010', { x: 2.7, z: 0 });
    room.state.lab.cuts.get(table)!.playerId = 'fur-player-0010';
    expect((await pickup(client, table)).text).toMatch(/découpe/);
  });
});

describe('labo — lampes (distance réelle)', () => {
  it('lampe posée à portée : pot accéléré sans saut ; éloignée : vitesse normale', async () => {
    const { client, room } = await newGame('fur-player-0011');
    await give(client, 'pot');
    await give(client, 'grow_lamp', 2);
    await give(client, 'seed_base');
    const potId = (await place(client, 'pot', -3, -2)).fixtureId!;
    standAt(room, 'fur-player-0011', { x: -3, z: -0.9 });
    // sans lampe : plantation refusée ; une lampe à portée : acceptée
    expect((await station(client, potId, 'plant')).text).toBe(NO_LAMP);
    const first = (await place(client, 'grow_lamp', -3, -2.7)).fixtureId!;
    expect((await station(client, potId, 'plant')).ok).toBe(true);
    const pot = room.state.lab.pots.get(potId)!;
    const base = 1 / (1 - LAMP.growReductionPerLamp);
    expect(pot.rate).toBeCloseTo(base, 5);
    // pousse simulée : arrosé longtemps, on mesure la progression à des instants choisis
    const t0 = pot.bankedAt;
    pot.wateredUntil = t0 + 10 * 60_000;

    const lampId = (await place(client, 'grow_lamp', -3 + LAMP.range - 0.1, -2)).fixtureId!;
    const rate = 1 / (1 - Math.min(2, LAMP.maxLamps) * LAMP.growReductionPerLamp);
    expect(pot.rate).toBeCloseTo(rate, 5);
    const atPose = potGrowMs(readPot(pot), pot.bankedAt, strain);
    expect(atPose).toBeCloseTo(Math.max(0, pot.bankedAt - t0), -1); // pas de saut
    const later = potGrowMs(readPot(pot), pot.bankedAt + 10_000, strain);
    expect(later - atPose).toBeCloseTo(10_000 * rate, 0);

    // la lampe s'éloigne au-delà de la portée : recalcul, toujours sans saut
    const banked = potGrowMs(readPot(pot), room.now(), strain);
    expect((await move(client, lampId, -3 + LAMP.range + 0.5, -2)).ok).toBe(true);
    expect(pot.rate).toBeCloseTo(base, 5);
    expect(potGrowMs(readPot(pot), pot.bankedAt, strain)).toBeCloseTo(banked, -2);

    // dernière lampe du pot en pousse : ni reprise, ni éloignée ; déplacée à portée : acceptée
    standAt(room, 'fur-player-0011', { x: -3, z: -1.4 });
    expect((await pickup(client, first)).text).toBe(LAMP_IN_USE);
    expect((await move(client, first, -3 + LAMP.range + 0.5, -3)).text).toBe(LAMP_IN_USE);
    expect((await move(client, first, -3 + LAMP.range - 0.3, -2.7)).ok).toBe(true);
    // la seconde lampe revient à portée : la première peut partir
    expect((await move(client, lampId, -3, -2.7)).ok).toBe(true);
    standAt(room, 'fur-player-0011', { x: -3 + LAMP.range - 0.3, z: -1.4 });
    expect((await pickup(client, first)).ok).toBe(true);
    // pot planté sorti de toute lumière : refusé
    expect((await move(client, potId, -3 + LAMP.range + 2.5, -2)).text).toBe(NO_LAMP);
  });

  it('cumul plafonné à maxLamps', async () => {
    const { client, room } = await newGame('fur-player-0012');
    await give(client, 'pot');
    const potId = (await place(client, 'pot', 0, -2)).fixtureId!;
    for (const [x, z] of [
      [0, -2],
      [0.7, -2],
      [-0.7, -2],
      [0, -2.7],
    ].slice(0, LAMP.maxLamps + 2))
      expect(
        'id' in spawnFurniture(room.state, lab, { itemId: 'grow_lamp', x: x!, z: z!, rot: 0 }, 0),
      ).toBe(true);
    const capped = 1 / (1 - LAMP.maxLamps * LAMP.growReductionPerLamp);
    expect(room.state.lab.pots.get(potId)!.rate).toBeCloseTo(capped, 5);
  });
});

describe('labo — debug', () => {
  it('équiper avec des placements valides générés, puis vider', async () => {
    const { client, room } = await newGame('fur-player-0013');
    client.send(ClientMsg.Debug, { cmd: 'equipLab' });
    expect(((await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage).ok).toBe(true);
    const kit = gameData.config.debug.equipKit;
    expect(room.state.lab.fixtures.size).toBe(Object.values(kit).reduce((a, b) => a + b, 0));
    expect(room.state.lab.pots.size).toBe(kit.pot);
    client.send(ClientMsg.Debug, { cmd: 'clearLab' });
    await client.waitForMessage(ServerMsg.Notice);
    expect(room.state.lab.fixtures.size + room.state.lab.pots.size).toBe(0);
  });
});
