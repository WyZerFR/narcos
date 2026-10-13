import { boot, type ColyseusTestServer } from '@colyseus/testing';
import {
  ClientMsg,
  ROOM_NAME,
  ServerMsg,
  gameData,
  maxBurstMeters,
  type CorrectionMessage,
  type MoveMessage,
} from '@narco/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGameServer } from '../src/app';
import type { GameState } from '../src/rooms/schema';

const { config } = gameData;
const burst = maxBurstMeters({
  maxSpeed: config.movement.runSpeed,
  toleranceFactor: config.movement.toleranceFactor,
  maxBurstMs: config.movement.maxBurstMs,
  bounds: config.world.bounds,
});

let colyseus: ColyseusTestServer;

beforeAll(async () => {
  colyseus = await boot(createGameServer());
});
afterAll(async () => {
  await colyseus.shutdown();
});
beforeEach(async () => {
  await colyseus.cleanup();
});

async function createRoomWith(playerId: string) {
  const client = await colyseus.sdk.create<GameState>(ROOM_NAME, { playerId, name: 'Testeur' });
  const room = colyseus.getRoomById<GameState>(client.roomId);
  return { client, room };
}

describe('NarcoRoom — mouvement autoritaire', () => {
  it('corrige une position impossible (téléportation)', async () => {
    const { client, room } = await createRoomWith('player-aaaa-0001');
    const before = { ...room.state.players.get('player-aaaa-0001')! };

    const teleport: MoveMessage = { x: before.x + 40, z: before.z + 30, rotY: 0, seq: 1 };
    client.send(ClientMsg.Move, teleport);
    const correction = (await client.waitForMessage(ServerMsg.Correction)) as CorrectionMessage;

    const after = room.state.players.get('player-aaaa-0001')!;
    const moved = Math.hypot(after.x - before.x, after.z - before.z);

    expect(correction.seq).toBe(1);
    expect(moved).toBeLessThanOrEqual(burst + 0.5); // crédit de rafale + recharge pendant le test
    expect(after.x).not.toBeCloseTo(teleport.x);
    expect(correction.x).toBeCloseTo(after.x, 3);
    expect(correction.z).toBeCloseTo(after.z, 3);
  });

  it('accepte un déplacement normal sans correction', async () => {
    const { client, room } = await createRoomWith('player-aaaa-0002');
    const before = { ...room.state.players.get('player-aaaa-0002')! };
    let corrected = false;
    client.onMessage(ServerMsg.Correction, () => (corrected = true));

    client.send(ClientMsg.Move, { x: before.x + 0.3, z: before.z, rotY: 1, seq: 1 });
    await room.waitForNextMessage();

    const after = room.state.players.get('player-aaaa-0002')!;
    expect(after.x).toBeCloseTo(before.x + 0.3, 4);
    expect(after.rotY).toBeCloseTo(1, 4);
    expect(corrected).toBe(false);
  });

  it('garde la position dans les bornes de la carte', async () => {
    const { client, room } = await createRoomWith('player-aaaa-0003');
    const p = room.state.players.get('player-aaaa-0003')!;
    p.x = config.world.bounds.maxX - 0.1;

    client.send(ClientMsg.Move, { x: config.world.bounds.maxX + 1, z: p.z, rotY: 0, seq: 2 });
    await client.waitForMessage(ServerMsg.Correction);
    expect(p.x).toBe(config.world.bounds.maxX);
  });
});

describe('NarcoRoom — room par code et reconnexion', () => {
  it('utilise un code de 4 lettres comme identifiant de room', async () => {
    const { client, room } = await createRoomWith('player-bbbb-0001');
    expect(client.roomId).toMatch(new RegExp(`^[${config.room.codeAlphabet}]{4}$`));
    expect(room.state.code).toBe(client.roomId);
  });

  it('réattache un joueur qui revient avec le même playerId, sans perte d’état', async () => {
    const { client, room } = await createRoomWith('player-bbbb-0002');
    const p = room.state.players.get('player-bbbb-0002')!;
    const { color } = p;
    client.send(ClientMsg.Move, { x: p.x + 0.3, z: p.z, rotY: 0, seq: 1 });
    await room.waitForNextMessage();
    const x = p.x;

    await client.leave(false); // coupure non volontaire
    await new Promise((r) => setTimeout(r, 50));
    expect(room.state.players.get('player-bbbb-0002')!.connected).toBe(false);

    await colyseus.sdk.joinById(room.roomId, { playerId: 'player-bbbb-0002', name: 'Testeur' });
    const back = room.state.players.get('player-bbbb-0002')!;
    expect(room.state.players.size).toBe(1);
    expect(back.connected).toBe(true);
    expect(back.color).toBe(color);
    expect(back.x).toBeCloseTo(x, 4);
  });

  it('attribue 3 couleurs distinctes et refuse un 4e joueur', async () => {
    const { room } = await createRoomWith('player-cccc-0001');
    await colyseus.sdk.joinById(room.roomId, { playerId: 'player-cccc-0002' });
    await colyseus.sdk.joinById(room.roomId, { playerId: 'player-cccc-0003' });

    const colors = new Set([...room.state.players.values()].map((p) => p.color));
    expect(colors.size).toBe(3);
    await expect(
      colyseus.sdk.joinById(room.roomId, { playerId: 'player-cccc-0004' }),
    ).rejects.toThrow(/pleine/);
  });
});
