import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room as ServerRoom } from '@colyseus/core';
import {
  add,
  ClientMsg,
  count,
  emptyInventory,
  gameData,
  interactionPoint,
  ROOM_NAME,
  ServerMsg,
  type NoticeMessage,
} from '@narco/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NarcoRoom } from '../src/rooms/NarcoRoom';
import { GameState } from '../src/rooms/schema';
import { readInventory } from '../src/rooms/stateSync';
import { hydrateState, RoomSnapshotSchema, SNAPSHOT_SCHEMA_VERSION } from '../src/persistence';
import { bootOn, furnish } from './helpers';

const { config } = gameData;
const nord = gameData.quartierLayouts.get('nord')!;
const sud = gameData.quartierLayouts.get('sud')!;

let colyseus: ColyseusTestServer;

beforeAll(async () => {
  colyseus = await bootOn(2580);
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

describe('quartiers — état et déplacements', () => {
  it('le serveur calcule l’area du joueur et la diffuse', async () => {
    const id = 'quartier-player-0001';
    const { client, room } = await newGame(id);
    const p = room.state.players.get(id)!;
    expect(p.area).toBe('street');
    // au bord de l'impasse nord, un pas vers le fond
    const start = { x: nord.frame.axisX, z: nord.frame.entranceZ + 0.2 };
    Object.assign(p, start);
    client.send(ClientMsg.Move, { zone: 'street', x: start.x, z: start.z - 0.5, rotY: 0, seq: 1 });
    await room.waitForNextMessage();
    expect(p.z).toBeCloseTo(start.z - 0.5, 3);
    expect(p.area).toBe('north');
  });

  it('collisions serveur : on ne traverse pas une maison du quartier sud', async () => {
    const id = 'quartier-player-0002';
    const { client, room } = await newGame(id);
    const p = room.state.players.get(id)!;
    const h = sud.houses[0]!;
    const zc = (h.rect.minZ + h.rect.maxZ) / 2;
    const start = { x: h.frontX - h.side * 1, z: zc };
    Object.assign(p, start);
    client.send(ClientMsg.Move, {
      zone: 'street',
      x: h.frontX + h.side * 1,
      z: zc,
      rotY: 0,
      seq: 1,
    });
    await client.waitForMessage(ServerMsg.Correction);
    expect(p.x >= h.rect.minX && p.x <= h.rect.maxX).toBe(false);
  });

  it('Le Local au bout de l’impasse sud : on entre, la sortie ramène devant sa porte', async () => {
    const id = 'quartier-player-0003';
    const { client, room } = await newGame(id);
    const p = room.state.players.get(id)!;
    const local = gameData.locations.get('local')!;
    const door = interactionPoint(local);
    Object.assign(p, door);
    client.send(ClientMsg.Interact, { locationId: 'local' });
    await client.waitForMessage(ServerMsg.Notice);
    expect(p.zone).toBe('lab');
    expect(p.area).toBe('');
    const exit = gameData.interiors.get('lab')!.stations.find((s) => s.kind === 'exit')!;
    Object.assign(p, { x: exit.position.x, z: exit.position.z - 0.5 });
    client.send(ClientMsg.Station, { stationId: exit.id, action: 'exit' });
    const n = (await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
    expect(n.ok, n.text).toBe(true);
    expect(p.zone).toBe('street');
    expect({ x: p.x, z: p.z }).toEqual(door);
    expect(p.area).toBe('south');
  });
});

describe('quartiers — migration d’une ancienne partie', () => {
  it('joueur de la rue dans un emplacement devenu maison : replacé au départ, sac et meubles gardés', () => {
    // une partie neuve, meublée, puis sauvegardée avec un joueur dans une maison du quartier nord
    const source = new GameState();
    const fakeRoom = { state: source, now: () => 0 } as unknown as NarcoRoom;
    furnish(fakeRoom, ['pot_1', 'rack_1']);
    const inside = nord.houses[0]!.rect;
    let bag = emptyInventory(config.inventory.bagSlots);
    const r = add(bag, 'pouch_base', 7, gameData.items);
    if (r.ok) bag = r.inv;
    const player = {
      id: 'old',
      name: 'Ancien',
      color: '#ffffff',
      x: (inside.minX + inside.maxX) / 2,
      z: (inside.minZ + inside.maxZ) / 2,
      zone: 'street',
      bag: bag.map((slot) => slot ?? { itemId: '', qty: 0 }),
      hasAccount: true,
      cleanBalance: 120,
      pactAccepted: true,
    };
    const lab = (source.toJSON() as { lab: unknown }).lab;
    const snap = RoomSnapshotSchema.parse({
      code: 'ABCD',
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      savedAt: 0,
      clock: { now: 0, scale: 1 },
      state: { ...new GameState().toJSON(), code: 'ABCD', lab, players: { old: player } },
    });
    const state = new GameState();
    hydrateState(state, snap);
    const p = state.players.get('old')!;
    const spawn = config.players.spawn;
    expect(Math.hypot(p.x - spawn.x, p.z - spawn.z)).toBeLessThan(1);
    expect(p.area).toBe('street');
    expect(count(readInventory(p.bag), 'pouch_base')).toBe(7);
    expect([p.hasAccount, p.cleanBalance, p.pactAccepted]).toEqual([true, 120, true]);
    expect(state.lab.fixtures.size).toBe(2);
  });

  it('joueur dans un intérieur : position conservée', () => {
    const snap = RoomSnapshotSchema.parse({
      code: 'ABCD',
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      savedAt: 0,
      clock: { now: 0, scale: 1 },
      state: {
        ...new GameState().toJSON(),
        code: 'ABCD',
        players: { lab: { id: 'lab', name: 'L', color: '#ffffff', x: 1, z: 2, zone: 'lab' } },
      },
    });
    const state = new GameState();
    hydrateState(state, snap);
    expect(state.players.get('lab')).toMatchObject({ x: 1, z: 2, zone: 'lab', area: '' });
  });
});
