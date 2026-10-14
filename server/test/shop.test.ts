import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room as ServerRoom } from '@colyseus/core';
import type { Room as ClientRoom } from 'colyseus.js';
import {
  ClientMsg,
  ROOM_NAME,
  ServerMsg,
  add,
  count,
  emptyInventory,
  gameData,
  type NoticeMessage,
  type StationAction,
} from '@narco/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NarcoRoom } from '../src/rooms/NarcoRoom';
import type { GameState } from '../src/rooms/schema';
import { readInventory, writeInventory } from '../src/rooms/stateSync';
import { bootOn } from './helpers';

type SdkRoom = ClientRoom<GameState>;

const shopShelves = gameData.shops.get('shop')!.shelves;
const price = (stationId: string) => shopShelves.find((s) => s.stationId === stationId)!.price;
const strain = gameData.economy.strains.find((s) => s.id === 'base')!;

let colyseus: ColyseusTestServer;

beforeAll(async () => {
  colyseus = await bootOn(2573);
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

/** Place un joueur dans un intérieur, devant un poste ou un emplacement (côté serveur). */
function goTo(room: NarcoRoom, playerId: string, interiorId: string, stationId: string) {
  const p = room.state.players.get(playerId)!;
  const interior = gameData.interiors.get(interiorId)!;
  const st = [...interior.stations, ...interior.fixtures].find((s) => s.id === stationId)!;
  p.zone = interiorId;
  p.x = st.position.x;
  p.z = st.position.z + st.size.d / 2 + 0.5;
}

async function act(
  client: SdkRoom,
  stationId: string,
  action: StationAction,
): Promise<NoticeMessage> {
  client.send(ClientMsg.Station, { stationId, action });
  return (await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
}

const bagOf = (room: NarcoRoom, id: string) => readInventory(room.state.players.get(id)!.bag);
const stockOf = (room: NarcoRoom, key: string) => room.state.shelves.get(key)!.stock;

function setCash(room: NarcoRoom, id: string, cash: number) {
  const r = add(
    emptyInventory(gameData.economy.inventory.bagSlots),
    'cash_dirty',
    cash,
    gameData.items,
  );
  if (r.ok) writeInventory(room.state.players.get(id)!.bag, r.inv);
}

describe('shop — panier et paiement', () => {
  it('prend 3 articles, calcule le total côté serveur, paie et range les achats', async () => {
    const { client, room } = await newGame('shop-player-0001');
    setCash(room, 'shop-player-0001', 200);
    goTo(room, 'shop-player-0001', 'shop', 'shelf_seeds');
    expect((await act(client, 'shelf_seeds', 'take')).ok).toBe(true);
    expect((await act(client, 'shelf_seeds', 'take')).ok).toBe(true);
    goTo(room, 'shop-player-0001', 'shop', 'shelf_pots');
    expect((await act(client, 'shelf_pots', 'take')).ok).toBe(true);

    const p = room.state.players.get('shop-player-0001')!;
    const total = 2 * price('shelf_seeds') + price('shelf_pots');
    expect(p.cartTotal).toBe(total);
    expect(stockOf(room, 'shop:shelf_pots')).toBe(
      shopShelves.find((s) => s.itemId === 'pot')!.stock! - 1,
    );

    goTo(room, 'shop-player-0001', 'shop', 'counter');
    const paid = await act(client, 'counter', 'pay');
    expect(paid.ok).toBe(true);
    const bag = bagOf(room, 'shop-player-0001');
    expect(count(bag, 'cash_dirty')).toBe(200 - total);
    expect(count(bag, 'seed_base')).toBe(2);
    expect(count(bag, 'pot')).toBe(1);
    expect(p.cart.length).toBe(0);
  });

  it('refuse de payer sans assez d’argent, de trop loin ou hors du magasin', async () => {
    const { client, room } = await newGame('shop-player-0002');
    setCash(room, 'shop-player-0002', price('shelf_pots') - 1);
    goTo(room, 'shop-player-0002', 'shop', 'shelf_pots');
    await act(client, 'shelf_pots', 'take');
    expect((await act(client, 'counter', 'pay')).text).toMatch(/Trop loin/);
    goTo(room, 'shop-player-0002', 'shop', 'counter');
    expect((await act(client, 'counter', 'pay')).text).toMatch(/Pas assez d'argent/);
    room.state.players.get('shop-player-0002')!.zone = 'street';
    expect((await act(client, 'counter', 'pay')).ok).toBe(false);
  });

  it('refuse de payer avec un sac plein, sans rien débiter', async () => {
    const { client, room } = await newGame('shop-player-0003');
    let inv = readInventory(room.state.players.get('shop-player-0003')!.bag);
    const r = add(emptyInventory(inv.length), 'cash_dirty', 500, gameData.items);
    if (r.ok) inv = r.inv;
    const filled = add(inv, 'scissors', inv.length - 1, gameData.items); // ciseaux : pile de 1
    if (filled.ok) writeInventory(room.state.players.get('shop-player-0003')!.bag, filled.inv);
    goTo(room, 'shop-player-0003', 'shop', 'shelf_seeds');
    await act(client, 'shelf_seeds', 'take');
    goTo(room, 'shop-player-0003', 'shop', 'counter');
    expect((await act(client, 'counter', 'pay')).text).toMatch(/Sac plein/);
    expect(count(bagOf(room, 'shop-player-0003'), 'cash_dirty')).toBe(500);
  });

  it('rend le panier au rayon en quittant le magasin, et « Retirer » repose un article', async () => {
    const { client, room } = await newGame('shop-player-0004');
    const key = 'shop:shelf_lamps';
    const initial = stockOf(room, key);
    goTo(room, 'shop-player-0004', 'shop', 'shelf_lamps');
    await act(client, 'shelf_lamps', 'take');
    await act(client, 'shelf_lamps', 'take');
    expect(stockOf(room, key)).toBe(initial - 2);
    client.send(ClientMsg.CartRemove, { stationId: 'shelf_lamps' });
    await room.waitForNextMessage();
    expect(stockOf(room, key)).toBe(initial - 1);
    goTo(room, 'shop-player-0004', 'shop', 'exit');
    expect((await act(client, 'exit', 'exit')).ok).toBe(true);
    expect(stockOf(room, key)).toBe(initial);
    expect(room.state.players.get('shop-player-0004')!.cart.length).toBe(0);
  });

  it('course au dernier article : un seul acheteur l’obtient', async () => {
    const { client: a, room } = await newGame('shop-player-0005');
    const b = await colyseus.sdk.joinById<GameState>(room.roomId, { playerId: 'shop-player-0006' });
    room.state.shelves.get('shop:shelf_pots')!.stock = 1;
    goTo(room, 'shop-player-0005', 'shop', 'shelf_pots');
    goTo(room, 'shop-player-0006', 'shop', 'shelf_pots');
    a.send(ClientMsg.Station, { stationId: 'shelf_pots', action: 'take' });
    b.send(ClientMsg.Station, { stationId: 'shelf_pots', action: 'take' });
    const notices = (await Promise.all([
      a.waitForMessage(ServerMsg.Notice),
      b.waitForMessage(ServerMsg.Notice),
    ])) as NoticeMessage[];
    expect(notices.filter((n) => n.ok)).toHaveLength(1);
    expect(notices.find((n) => !n.ok)!.text).toMatch(/Rupture/);
    expect(stockOf(room, 'shop:shelf_pots')).toBe(0);
  });
});

describe('shop → labo', () => {
  it('labo vide équipé depuis zéro avec l’argent de départ : achat, installation, pochons', async () => {
    const { client, room } = await newGame('shop-player-0007');
    client.send(ClientMsg.Debug, { cmd: 'timeScale', scale: 60 });
    await client.waitForMessage(ServerMsg.Notice);
    expect(room.state.lab.fixtures.size).toBe(0);
    // kit minimal, payé avec l'argent sale de départ uniquement
    for (const shelf of ['shelf_seeds', 'shelf_pots', 'shelf_racks', 'shelf_tables']) {
      goTo(room, 'shop-player-0007', 'shop', shelf);
      expect((await act(client, shelf, 'take')).ok).toBe(true);
    }
    goTo(room, 'shop-player-0007', 'shop', 'counter');
    expect((await act(client, 'counter', 'pay')).ok).toBe(true);
    const bag = bagOf(room, 'shop-player-0007');
    for (const id of ['seed_base', 'pot', 'drying_rack', 'cutting_table'])
      expect(count(bag, id)).toBe(1);

    const install = async (fixtureId: string) => {
      goTo(room, 'shop-player-0007', 'lab', fixtureId);
      // devant l'emplacement, hors de son emprise
      const p = room.state.players.get('shop-player-0007')!;
      p.z += 0.5;
      client.send(ClientMsg.Fixture, { fixtureId, action: 'install' });
      const n = (await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
      expect(n.ok, n.text).toBe(true);
    };
    await install('pot_1');
    await install('rack_1');
    await install('table_1');
    expect([...room.state.lab.fixtures.keys()].sort()).toEqual(['pot_1', 'rack_1', 'table_1']);

    const retry = async (stationId: string, action: StationAction) => {
      let n = await act(client, stationId, action);
      while (!n.ok) {
        await new Promise((r) => setTimeout(r, 150));
        n = await act(client, stationId, action);
      }
    };
    goTo(room, 'shop-player-0007', 'lab', 'pot_1');
    expect((await act(client, 'pot_1', 'plant')).ok).toBe(true);
    for (let i = 0; i < Math.ceil(strain.growSeconds / strain.waterEverySeconds); i++) {
      goTo(room, 'shop-player-0007', 'lab', 'water');
      await act(client, 'water', 'fill');
      goTo(room, 'shop-player-0007', 'lab', 'pot_1');
      await retry('pot_1', 'water');
    }
    await retry('pot_1', 'harvest');
    goTo(room, 'shop-player-0007', 'lab', 'rack_1');
    await retry('rack_1', 'hang');
    await retry('rack_1', 'collect');
    goTo(room, 'shop-player-0007', 'lab', 'table_1');
    await retry('table_1', 'cut');
    await client.waitForMessage(ServerMsg.Notice);
    expect(count(bagOf(room, 'shop-player-0007'), 'pouch_base')).toBe(
      strain.freshPerPlant * strain.pouchesPerDried,
    );
  }, 20000);
});
