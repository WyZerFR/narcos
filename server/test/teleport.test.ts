import type { ColyseusTestServer } from '@colyseus/testing';
import { bootOn } from './helpers';
import {
  ClientMsg,
  ROOM_NAME,
  ServerMsg,
  gameData,
  interactionPoint,
  maxBurstMeters,
  type CorrectionMessage,
  type MoveMessage,
  type NoticeMessage,
} from '@narco/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  colyseus = await bootOn(2570);
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

    const teleport: MoveMessage = {
      zone: 'street',
      x: before.x + 40,
      z: before.z + 30,
      rotY: 0,
      seq: 1,
    };
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

    client.send(ClientMsg.Move, {
      zone: 'street',
      x: before.x + 0.3,
      z: before.z,
      rotY: 1,
      seq: 1,
    });
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

    client.send(ClientMsg.Move, {
      zone: 'street',
      x: config.world.bounds.maxX + 1,
      z: p.z,
      rotY: 0,
      seq: 2,
    });
    await client.waitForMessage(ServerMsg.Correction);
    expect(p.x).toBe(config.world.bounds.maxX);
  });
});

describe('NarcoRoom — collisions', () => {
  it('refuse un mouvement qui traverse un bâtiment', async () => {
    const { client, room } = await createRoomWith('player-dddd-0001');
    // Immeuble "nw_angle" : x ∈ [-11, -7], z ∈ [-20, -10]. On part du trottoir à l'est.
    const block = gameData.blocks.find((b) => b.id === 'nw_angle')!;
    const wallX = block.position.x + block.size.w / 2;
    const p = room.state.players.get('player-dddd-0001')!;
    p.x = wallX + 0.6;
    p.z = block.position.z;

    client.send(ClientMsg.Move, {
      zone: 'street',
      x: wallX - block.size.w - 0.6,
      z: p.z,
      rotY: 0,
      seq: 3,
    });
    const correction = (await client.waitForMessage(ServerMsg.Correction)) as CorrectionMessage;

    expect(p.x).toBeGreaterThanOrEqual(wallX + config.world.playerRadius - 1e-3);
    expect(correction.x).toBeCloseTo(p.x, 3);
  });

  it('fait apparaître les joueurs hors des obstacles, près du carton', async () => {
    const { room } = await createRoomWith('player-dddd-0002');
    const p = room.state.players.get('player-dddd-0002')!;
    const { spawn, spawnSpread } = config.players;
    expect(Math.hypot(p.x - spawn.x, p.z - spawn.z)).toBeLessThanOrEqual(spawnSpread + 0.01);
  });
});

describe('NarcoRoom — interaction avec les lieux', () => {
  it('accepte l’entrée près de la porte et renvoie la réplique du lieu', async () => {
    const { client, room } = await createRoomWith('player-eeee-0001');
    const loc = gameData.locations.get('epicerie')!;
    const p = room.state.players.get('player-eeee-0001')!;
    const door = interactionPoint(loc);
    p.x = door.x;
    p.z = door.z;

    client.send(ClientMsg.Interact, { locationId: 'epicerie' });
    const notice = (await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
    expect(notice).toEqual({ ok: true, text: loc.enterText, locationId: 'epicerie' });
  });

  it('refuse l’entrée de loin', async () => {
    const { client } = await createRoomWith('player-eeee-0002'); // au carton de départ
    client.send(ClientMsg.Interact, { locationId: 'repaire_jefe' });
    const notice = (await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
    expect(notice.ok).toBe(false);
    expect(notice.text).toMatch(/Trop loin/);
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
    client.send(ClientMsg.Move, { zone: 'street', x: p.x + 0.3, z: p.z, rotY: 0, seq: 1 });
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
