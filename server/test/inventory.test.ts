import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room as ServerRoom } from '@colyseus/core';
import type { Room as ClientRoom } from 'colyseus.js';
import {
  ClientMsg,
  ROOM_NAME,
  ServerMsg,
  type InventoryKind,
  type InventoryMoveMessage,
  type MoveResultMessage,
} from '@narco/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NarcoRoom } from '../src/rooms/NarcoRoom';
import type { GameState } from '../src/rooms/schema';
import { readInventory, writeInventory } from '../src/rooms/stateSync';
import { bootOn } from './helpers';

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

  it('refuse tout ce qui touche au stock commun (désactivé)', async () => {
    const { client, room } = await newGame('inv-player-0002');
    setBag(room, 'inv-player-0002', [['food', 1]]);
    const stock = 'stock' as unknown as InventoryKind;
    const to = await move(client, {
      from: { inv: 'bag', slot: 0 },
      to: { inv: stock, slot: 0 },
      itemId: 'food',
    });
    expect(to).toMatchObject({ ok: false, text: 'Déplacement invalide.' });
    const from = await move(client, {
      from: { inv: stock, slot: 0 },
      to: { inv: 'bag', slot: 1 },
      itemId: 'food',
    });
    expect(from.ok).toBe(false);
    expect(readInventory(room.state.players.get('inv-player-0002')!.bag)[0]).toEqual({
      itemId: 'food',
      qty: 1,
    });
  });

  it('mouvements concurrents sur le même slot du sac : un seul gagne', async () => {
    const { client, room } = await newGame('inv-player-0003');
    setBag(room, 'inv-player-0003', [['food', 2]]);
    const results: MoveResultMessage[] = [];
    client.onMessage(ServerMsg.MoveResult, (r: MoveResultMessage) => results.push(r));
    const msg = (requestId: number, slot: number): InventoryMoveMessage => ({
      requestId,
      from: { inv: 'bag', slot: 0 },
      to: { inv: 'bag', slot },
      itemId: 'food',
    });
    client.send(ClientMsg.InventoryMove, msg(9001, 8));
    client.send(ClientMsg.InventoryMove, msg(9002, 9));
    while (results.length < 2) await new Promise((r) => setTimeout(r, 20));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)!.text).toMatch(/déjà bougé/);
    const bag = readInventory(room.state.players.get('inv-player-0003')!.bag);
    expect(bag[8]).toEqual({ itemId: 'food', qty: 2 });
    expect(bag[9]).toBeNull();
  });
});

describe('Trier côté serveur', () => {
  it('regroupe et range le sac du joueur', async () => {
    const { client, room } = await newGame('inv-player-0005');
    setBag(room, 'inv-player-0005', [null, ['water', 1], ['seed_base', 2], ['water', 2]]);
    client.send(ClientMsg.InventorySort);
    await room.waitForNextMessage();
    const bag = readInventory(room.state.players.get('inv-player-0005')!.bag);
    expect(bag.slice(0, 3)).toEqual([
      { itemId: 'seed_base', qty: 2 },
      { itemId: 'water', qty: 3 },
      null,
    ]);
  });
});
