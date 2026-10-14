import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room as ServerRoom } from '@colyseus/core';
import type { Room as ClientRoom } from 'colyseus.js';
import {
  ClientMsg,
  ROOM_NAME,
  ServerMsg,
  count,
  gameData,
  potGrowMs,
  type NoticeMessage,
} from '@narco/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NarcoRoom } from '../src/rooms/NarcoRoom';
import type { GameState } from '../src/rooms/schema';
import { readInventory, readPot } from '../src/rooms/stateSync';
import { installTestLabFixtures } from '@narco/shared/src/testing/labFixtures';
import { bootOn } from './helpers';

/** Le labo du jeu est vide : on installe sur les emplacements de l'ancien labo meublé. */
installTestLabFixtures();

type SdkRoom = ClientRoom<GameState>;

const lab = gameData.interiors.get('lab')!;
const fixture = (id: string) => lab.fixtures.find((f) => f.id === id)!;
const strain = gameData.economy.strains.find((s) => s.id === 'base')!;
const LAMP = gameData.economy.lab.lamp;

let colyseus: ColyseusTestServer;

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
  return { client, room };
}

/** Place le joueur dans le labo, devant l'emplacement (hors de son emprise). */
function goTo(room: NarcoRoom, playerId: string, fixtureId: string) {
  const p = room.state.players.get(playerId)!;
  const f = fixture(fixtureId);
  p.zone = 'lab';
  p.x = f.position.x;
  p.z = f.position.z + f.size.d / 2 + 0.6;
}

async function send(client: SdkRoom, type: string, msg: object): Promise<NoticeMessage> {
  client.send(type, msg);
  return (await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
}
const install = (c: SdkRoom, fixtureId: string) =>
  send(c, ClientMsg.Fixture, { fixtureId, action: 'install' });
const uninstall = (c: SdkRoom, fixtureId: string) =>
  send(c, ClientMsg.Fixture, { fixtureId, action: 'uninstall' });
const give = (c: SdkRoom, itemId: string, qty = 1) =>
  send(c, ClientMsg.Debug, { cmd: 'give', itemId, qty });

const bagOf = (room: NarcoRoom, id: string) => readInventory(room.state.players.get(id)!.bag);

describe('labo — installer / démonter', () => {
  it('installe un pot depuis le sac, puis le démonte et le rend au sac', async () => {
    const { client, room } = await newGame('fix-player-0001');
    await give(client, 'pot');
    goTo(room, 'fix-player-0001', 'pot_1');
    const n = await install(client, 'pot_1');
    expect(n.ok, n.text).toBe(true);
    expect(room.state.lab.fixtures.get('pot_1')!.itemId).toBe('pot');
    expect(room.state.lab.pots.has('pot_1')).toBe(true);
    expect(count(bagOf(room, 'fix-player-0001'), 'pot')).toBe(0);

    expect((await uninstall(client, 'pot_1')).ok).toBe(true);
    expect(room.state.lab.fixtures.has('pot_1')).toBe(false);
    expect(room.state.lab.pots.has('pot_1')).toBe(false);
    expect(count(bagOf(room, 'fix-player-0001'), 'pot')).toBe(1);
  });

  it('refuse : mauvaise zone, trop loin, mauvais type, emplacement occupé', async () => {
    const { client, room } = await newGame('fix-player-0002');
    await give(client, 'pot', 2);
    // dans la rue
    expect((await install(client, 'pot_1')).ok).toBe(false);
    // trop loin
    const p = room.state.players.get('fix-player-0002')!;
    p.zone = 'lab';
    p.x = 5.8;
    p.z = 3.4;
    expect((await install(client, 'pot_1')).text).toMatch(/Trop loin/);
    // mauvais type : un pot ne va pas sur un emplacement de lampe
    goTo(room, 'fix-player-0002', 'lamp_4');
    expect((await install(client, 'lamp_4')).text).toMatch(/rien de compatible/);
    // occupé
    goTo(room, 'fix-player-0002', 'pot_2');
    expect((await install(client, 'pot_2')).ok).toBe(true);
    expect((await install(client, 'pot_2')).text).toMatch(/occupé/);
    expect(count(bagOf(room, 'fix-player-0002'), 'pot')).toBe(1);
    // emplacement inconnu, démonter un emplacement vide
    expect((await install(client, 'nulle_part')).ok).toBe(false);
    goTo(room, 'fix-player-0002', 'pot_1');
    expect((await uninstall(client, 'pot_1')).ok).toBe(false);
  });

  it('refuse d’installer un meuble sur un joueur', async () => {
    const { client, room } = await newGame('fix-player-0003');
    await give(client, 'cutting_table');
    const p = room.state.players.get('fix-player-0003')!;
    const f = fixture('table_1');
    p.zone = 'lab';
    p.x = f.position.x;
    p.z = f.position.z + f.size.d / 2; // à cheval sur le bord
    expect((await install(client, 'table_1')).text).toMatch(/dans le passage/);
  });

  it('refuse de démonter un pot planté, un étendoir chargé, une table au travail', async () => {
    const { client, room } = await newGame('fix-player-0004');
    for (const id of ['pot', 'drying_rack', 'cutting_table']) await give(client, id);
    for (const id of ['pot_1', 'rack_1', 'table_1']) {
      goTo(room, 'fix-player-0004', id);
      expect((await install(client, id)).ok).toBe(true);
    }
    await give(client, 'seed_base');
    goTo(room, 'fix-player-0004', 'pot_1');
    expect(
      (await send(client, ClientMsg.Station, { stationId: 'pot_1', action: 'plant' })).ok,
    ).toBe(true);
    expect((await uninstall(client, 'pot_1')).text).toMatch(/plante/);

    await give(client, 'plant_fresh_base', 2);
    goTo(room, 'fix-player-0004', 'rack_1');
    expect(
      (await send(client, ClientMsg.Station, { stationId: 'rack_1', action: 'hang' })).ok,
    ).toBe(true);
    expect((await uninstall(client, 'rack_1')).text).toMatch(/chargé/);

    await give(client, 'plant_dried_base', 1);
    goTo(room, 'fix-player-0004', 'table_1');
    expect(
      (await send(client, ClientMsg.Station, { stationId: 'table_1', action: 'cut' })).ok,
    ).toBe(true);
    expect((await uninstall(client, 'table_1')).text).toMatch(/découpe/);
    expect(room.state.lab.fixtures.size).toBe(3);
  });

  it('un étendoir ou une table pas installé ne répond pas', async () => {
    const { client, room } = await newGame('fix-player-0005');
    goTo(room, 'fix-player-0005', 'rack_2');
    const n = await send(client, ClientMsg.Station, { stationId: 'rack_2', action: 'hang' });
    expect(n.text).toMatch(/Rien n'est installé/);
  });
});

describe('labo — lampes (horloge simulée)', () => {
  it('une lampe à portée accélère le pot, sans saut de progression à la pose', async () => {
    const { client, room } = await newGame('fix-player-0006');
    await give(client, 'pot');
    await give(client, 'grow_lamp', 1);
    await give(client, 'seed_base');
    goTo(room, 'fix-player-0006', 'pot_1');
    await install(client, 'pot_1');
    expect(
      (await send(client, ClientMsg.Station, { stationId: 'pot_1', action: 'plant' })).ok,
    ).toBe(true);
    const pot = room.state.lab.pots.get('pot_1')!;
    expect(pot.rate).toBe(1);

    // pousse simulée : arrosé depuis la plantation, on avance l'horloge à la main
    const t0 = pot.bankedAt;
    pot.wateredUntil = t0 + 10 * 60_000;
    const before = potGrowMs(readPot(pot), t0 + 10_000, strain);
    expect(before).toBeCloseTo(10_000, 0);

    // lamp_1 est à portée de pot_1 : pose en cours de pousse
    goTo(room, 'fix-player-0006', 'lamp_1');
    const now = room.now();
    expect((await install(client, 'lamp_1')).ok).toBe(true);
    const rate = 1 / (1 - LAMP.growReductionPerLamp);
    expect(pot.rate).toBeCloseTo(rate, 5);
    // pas de saut : la progression à l'instant de la pose est inchangée
    const atInstall = potGrowMs(readPot(pot), pot.bankedAt, strain);
    expect(atInstall).toBeCloseTo(Math.max(0, pot.bankedAt - t0), -1);
    // ensuite, 10 s de jeu valent 10 s × rate de pousse
    const later = potGrowMs(readPot(pot), pot.bankedAt + 10_000, strain);
    expect(later - atInstall).toBeCloseTo(10_000 * rate, 0);
    expect(pot.bankedAt).toBeGreaterThanOrEqual(now);

    // retirer la lampe rend la vitesse normale
    expect((await uninstall(client, 'lamp_1')).ok).toBe(true);
    expect(pot.rate).toBe(1);
  });

  it('cumul plafonné à maxLamps, et une lampe hors de portée ne compte pas', async () => {
    const { client, room } = await newGame('fix-player-0007');
    client.send(ClientMsg.Debug, { cmd: 'give', itemId: 'pot', qty: 1 });
    await client.waitForMessage(ServerMsg.Notice);
    goTo(room, 'fix-player-0007', 'pot_1');
    await install(client, 'pot_1');
    goTo(room, 'fix-player-0007', 'pot_1');
    expect((await send(client, ClientMsg.Debug, { cmd: 'equipLab' })).ok).toBe(true);
    const capped = 1 / (1 - LAMP.maxLamps * LAMP.growReductionPerLamp);
    expect(room.state.lab.pots.get('pot_1')!.rate).toBeCloseTo(capped, 5);
    // les autres pots : nombre de lampes à portée recompté ici, indépendamment de lampRate
    for (const id of ['pot_2', 'pot_3', 'pot_4']) {
      const pos = fixture(id).position;
      const n = lab.fixtures.filter(
        (f) =>
          f.accepts === 'lamp' &&
          Math.hypot(f.position.x - pos.x, f.position.z - pos.z) <= LAMP.range,
      ).length;
      const expected = 1 / (1 - Math.min(n, LAMP.maxLamps) * LAMP.growReductionPerLamp);
      expect(room.state.lab.pots.get(id)!.rate).toBeCloseTo(expected, 5);
    }
    // debug : vider le labo
    expect((await send(client, ClientMsg.Debug, { cmd: 'clearLab' })).ok).toBe(true);
    expect(room.state.lab.fixtures.size).toBe(0);
  });
});
