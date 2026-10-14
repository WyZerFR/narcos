import type { ColyseusTestServer } from '@colyseus/testing';
import { bootOn } from './helpers';
import {
  ClientMsg,
  ROOM_NAME,
  ServerMsg,
  gameData,
  interactionPoint,
  type NoticeMessage,
} from '@narco/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GameState } from '../src/rooms/schema';

const lab = gameData.interiors.get('lab')!;
const local = gameData.locations.get('local')!;
const exit = lab.stations.find((s) => s.kind === 'exit')!;

let colyseus: ColyseusTestServer;

beforeAll(async () => {
  colyseus = await bootOn(2571);
});
afterAll(async () => {
  await colyseus.shutdown();
});
beforeEach(async () => {
  await colyseus.cleanup();
});

async function roomAtLocalDoor(playerId: string) {
  const client = await colyseus.sdk.create<GameState>(ROOM_NAME, { playerId, name: 'Testeur' });
  const room = colyseus.getRoomById<GameState>(client.roomId);
  const p = room.state.players.get(playerId)!;
  const door = interactionPoint(local);
  p.x = door.x;
  p.z = door.z;
  return { client, room, p };
}

describe('zones — rue ↔ labo', () => {
  it('entre dans le labo par la porte du local, au point d’apparition', async () => {
    const { client, p } = await roomAtLocalDoor('player-zone-0001');
    client.send(ClientMsg.Interact, { locationId: 'local' });
    const notice = (await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
    expect(notice.ok).toBe(true);
    expect(p.zone).toBe('lab');
    expect({ x: p.x, z: p.z }).toEqual(lab.spawn);
  });

  it('ignore une position calculée dans l’ancienne zone', async () => {
    const { client, room, p } = await roomAtLocalDoor('player-zone-0002');
    client.send(ClientMsg.Interact, { locationId: 'local' });
    await client.waitForMessage(ServerMsg.Notice);
    client.send(ClientMsg.Move, { zone: 'street', x: p.x + 0.3, z: p.z, rotY: 0, seq: 9 });
    await room.waitForNextMessage();
    expect({ x: p.x, z: p.z }).toEqual(lab.spawn);
  });

  it('ressort devant la porte du local', async () => {
    const { client, p } = await roomAtLocalDoor('player-zone-0003');
    client.send(ClientMsg.Interact, { locationId: 'local' });
    await client.waitForMessage(ServerMsg.Notice);
    p.x = exit.position.x;
    p.z = exit.position.z - 0.8;
    client.send(ClientMsg.Station, { stationId: exit.id, action: 'exit' });
    const notice = (await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
    expect(notice.ok).toBe(true);
    expect(p.zone).toBe('street');
    const door = interactionPoint(local);
    expect(p.x).toBeCloseTo(door.x, 3);
    expect(p.z).toBeCloseTo(door.z, 3);
  });

  it('refuse une action de poste depuis la rue', async () => {
    const { client, p } = await roomAtLocalDoor('player-zone-0004');
    client.send(ClientMsg.Station, { stationId: exit.id, action: 'exit' });
    const notice = (await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
    expect(notice.ok).toBe(false);
    expect(p.zone).toBe('street');
  });

  it('refuse une action de poste trop loin', async () => {
    const { client, p } = await roomAtLocalDoor('player-zone-0005');
    client.send(ClientMsg.Interact, { locationId: 'local' });
    await client.waitForMessage(ServerMsg.Notice);
    const stock = lab.stations.find((s) => s.kind === 'stock')!;
    client.send(ClientMsg.Station, { stationId: stock.id, action: 'open' });
    const notice = (await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
    expect(notice.ok).toBe(false);
    expect(notice.text).toMatch(/Trop loin/);
    expect(p.zone).toBe('lab');
  });

  it('collisions du labo : on ne traverse pas un poste solide', async () => {
    const { client, p } = await roomAtLocalDoor('player-zone-0006');
    client.send(ClientMsg.Interact, { locationId: 'local' });
    await client.waitForMessage(ServerMsg.Notice);
    const pot = lab.fixtures.find((s) => s.id === 'pot_1')!;
    // emplacement vide : on passe à travers
    p.x = pot.position.x;
    p.z = pot.position.z + pot.size.d / 2 + 0.6;
    client.send(ClientMsg.Move, { zone: 'lab', x: p.x, z: pot.position.z, rotY: 0, seq: 1 });
    await new Promise((r) => setTimeout(r, 100));
    expect(p.z).toBeCloseTo(pot.position.z, 3);
    // pot installé : il bloque
    client.send(ClientMsg.Debug, { cmd: 'equipLab' });
    await client.waitForMessage(ServerMsg.Notice);
    p.x = pot.position.x;
    p.z = pot.position.z + pot.size.d / 2 + 0.6;
    client.send(ClientMsg.Move, { zone: 'lab', x: p.x, z: pot.position.z - 1.5, rotY: 0, seq: 2 });
    await client.waitForMessage(ServerMsg.Correction);
    expect(p.z).toBeGreaterThan(pot.position.z + pot.size.d / 2);
  });
});
