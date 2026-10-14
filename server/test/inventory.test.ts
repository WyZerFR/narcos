import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room as ServerRoom } from '@colyseus/core';
import type { Room as ClientRoom } from 'colyseus.js';
import {
  ClientMsg,
  ROOM_NAME,
  ServerMsg,
  gameData,
  type InventoryMoveMessage,
  type MoveResultMessage,
} from '@narco/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NarcoRoom } from '../src/rooms/NarcoRoom';
import type { GameState } from '../src/rooms/schema';
import { readInventory, writeInventory } from '../src/rooms/stateSync';
import { bootOn } from './helpers';

const lab = gameData.interiors.get('lab')!;
const crate = lab.stations.find((s) => s.kind === 'stock')!;
let colyseus: ColyseusTestServer;
let nextId = 1;

beforeAll(async () => {
  colyseus = await bootOn(2575);
});
afterAll(async () => {
  await colyseus.shutdown();
});
beforeEach(async () => {
  await colyseus.cleanup();
});

async function newGame(playerId: string) {
  const client = await colyseus.sdk.create<GameState>(ROOM_NAME, { playerId, name: 'Rangeur' });
  const room = colyseus.getRoomById<GameState>(client.roomId) as ServerRoom<GameState> as NarcoRoom;
  return { client, room };
}

function nearCrate(room: NarcoRoom, playerId: string) {
  const p = room.state.players.get(playerId)!;
  p.zone = 'lab';
  p.x = crate.position.x - crate.size.w / 2 - 0.6;
  p.z = crate.position.z;
}

async function move(
  client: ClientRoom<GameState>,
  m: Omit<InventoryMoveMessage, 'requestId'>,
): Promise<MoveResultMessage> {
  const msg: InventoryMoveMessage = { ...m, requestId: nextId++ };
  client.send(ClientMsg.InventoryMove, msg);
  return (await client.waitForMessage(ServerMsg.MoveResult)) as MoveResultMessage;
}

const setBag = (room: NarcoRoom, id: string, stacks: ([string, number] | null)[]) => {
  const p = room.state.players.get(id)!;
  const inv = Array.from({ length: p.bag.length }, (_, i) => {
    const s = stacks[i];
    return s ? { itemId: s[0], qty: s[1] } : null;
  });
  writeInventory(p.bag, inv);
};

describe('glisser-déposer côté serveur', () => {
  it('déplace, fusionne et échange dans le sac', async () => {
    const { client, room } = await newGame('inv-player-0001');
    setBag(room, 'inv-player-0001', [
      ['water', 2],
      ['water', 1],
      ['seed_base', 3],
    ]);
    expect(
      (
        await move(client, {
          from: { inv: 'bag', slot: 0 },
          to: { inv: 'bag', slot: 5 },
          itemId: 'water',
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await move(client, {
          from: { inv: 'bag', slot: 1 },
          to: { inv: 'bag', slot: 5 },
          itemId: 'water',
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await move(client, {
          from: { inv: 'bag', slot: 2 },
          to: { inv: 'bag', slot: 5 },
          itemId: 'seed_base',
        })
      ).ok,
    ).toBe(true);
    const bag = readInventory(room.state.players.get('inv-player-0001')!.bag);
    expect(bag[5]).toEqual({ itemId: 'seed_base', qty: 3 });
    expect(bag[2]).toEqual({ itemId: 'water', qty: 3 });
    expect(bag[0]).toBeNull();
  });

  it('refuse un transfert vers le stock loin de la caisse, l’accepte à côté', async () => {
    const { client, room } = await newGame('inv-player-0002');
    setBag(room, 'inv-player-0002', [['food', 1]]);
    const free = readInventory(room.state.lab.stock).findIndex((s) => s === null);
    const far = await move(client, {
      from: { inv: 'bag', slot: 0 },
      to: { inv: 'stock', slot: free },
      itemId: 'food',
    });
    expect(far.ok).toBe(false);
    expect(far.text).toMatch(/caisse/);
    nearCrate(room, 'inv-player-0002');
    expect(
      (
        await move(client, {
          from: { inv: 'bag', slot: 0 },
          to: { inv: 'stock', slot: free },
          itemId: 'food',
        })
      ).ok,
    ).toBe(true);
    expect(readInventory(room.state.lab.stock)[free]).toEqual({ itemId: 'food', qty: 1 });
  });

  it('mouvements concurrents sur le même slot du stock : un seul gagne', async () => {
    const { client: a, room } = await newGame('inv-player-0003');
    const b = await colyseus.sdk.joinById<GameState>(room.roomId, { playerId: 'inv-player-0004' });
    nearCrate(room, 'inv-player-0003');
    nearCrate(room, 'inv-player-0004');
    const stock = readInventory(room.state.lab.stock);
    const slot = stock.findIndex((s) => s !== null);
    const itemId = stock[slot]!.itemId;
    setBag(room, 'inv-player-0003', []);
    setBag(room, 'inv-player-0004', []);
    const msg = (requestId: number): InventoryMoveMessage => ({
      requestId,
      from: { inv: 'stock', slot },
      to: { inv: 'bag', slot: 9 },
      itemId,
    });
    a.send(ClientMsg.InventoryMove, msg(9001));
    b.send(ClientMsg.InventoryMove, msg(9002));
    const results = (await Promise.all([
      a.waitForMessage(ServerMsg.MoveResult),
      b.waitForMessage(ServerMsg.MoveResult),
    ])) as MoveResultMessage[];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)!.text).toMatch(/déjà bougé/);
  });
});
