import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room as ServerRoom } from '@colyseus/core';
import { ClientMsg, gameData, ROOM_NAME, ServerMsg } from '@narco/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NarcoRoom } from '../src/rooms/NarcoRoom';
import type { GameState } from '../src/rooms/schema';
import { bootOn } from './helpers';

const radius = gameData.config.world.playerRadius;

let colyseus: ColyseusTestServer;

beforeAll(async () => {
  colyseus = await bootOn(2586);
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

describe('île — la côte arrête le joueur (serveur)', () => {
  // bout ouest de l'avenue (bord de la carte) et bout sud de la rue du centre-ville (côte
  // intérieure) : un pas vers la mer est corrigé, le joueur reste sur l'île à un rayon du bord
  const cases = [
    { from: { x: -144, z: 0 }, to: { x: -145.6, z: 0 }, axis: 'x', coast: -145, out: -1 },
    { from: { x: 0, z: 44 }, to: { x: 0, z: 45.6 }, axis: 'z', coast: 45, out: 1 },
  ] as const;

  for (const [i, c] of cases.entries())
    it(`vers la mer en ${c.axis} = ${c.coast} : correction, aucun pied dans l’eau`, async () => {
      const id = `ile-player-000${i + 1}`;
      const { client, room } = await newGame(id);
      const p = room.state.players.get(id)!;
      Object.assign(p, c.from);
      client.send(ClientMsg.Move, { zone: 'street', ...c.to, rotY: 0, seq: 1 });
      await client.waitForMessage(ServerMsg.Correction);
      const reach = c.out * (p[c.axis] - c.coast);
      expect(reach).toBeLessThanOrEqual(-radius + 1e-6);
      expect(p.area).not.toBe('');
    });
});

describe('aéroport verrouillé (serveur)', () => {
  const { gate } = gameData.config.airport;
  const edge = gameData.areas.get(gameData.config.airport.areaId)!.bounds.maxZ;

  it('un pas vers le portail fermé est corrigé, le joueur reste en ville', async () => {
    const id = 'ile-player-0010';
    const { client, room } = await newGame(id);
    const p = room.state.players.get(id)!;
    Object.assign(p, { x: gate.x, z: edge + 1 });
    client.send(ClientMsg.Move, { zone: 'street', x: gate.x, z: gate.z - 2, rotY: 0, seq: 1 });
    await client.waitForMessage(ServerMsg.Correction);
    expect(p.z).toBeGreaterThanOrEqual(edge + radius - 1e-6);
    expect(p.area).toBe('centre_ville');
  });

  it('aucun PNJ dans l’aéroport', async () => {
    const { room } = await newGame('ile-player-0011');
    room.npcs.spawnAll(Date.now()); // toutes les areas peuplées, comme si chacune était occupée
    const areas = [...room.state.npcs.values()].map((n) => room.npcs.areaOf(n.id));
    expect(areas.length).toBeGreaterThan(0);
    expect(areas).not.toContain(gameData.config.airport.areaId);
  });
});
