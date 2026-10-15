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
  NO_LAMP,
  interactionPoint,
  type FixturePlaceMessage,
  type FixtureResultMessage,
  type NoticeMessage,
  type StationAction,
} from '@narco/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NarcoRoom } from '../src/rooms/NarcoRoom';
import { GameState } from '../src/rooms/schema';
import { hydrateState, RoomSnapshotSchema, SNAPSHOT_SCHEMA_VERSION } from '../src/persistence';
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

/** Place un joueur dans un intérieur, devant un poste fixe ou un meuble posé (côté serveur). */
function goTo(room: NarcoRoom, playerId: string, interiorId: string, stationId: string) {
  const p = room.state.players.get(playerId)!;
  const interior = gameData.interiors.get(interiorId)!;
  const furniture = room.state.lab.fixtures.get(stationId);
  const def = furniture && gameData.items.get(furniture.itemId)!.placeable!;
  const st = interior.stations.find((s) => s.id === stationId);
  const at = furniture
    ? { x: furniture.x, z: furniture.z + def!.d / 2 + 0.5 }
    : { x: st!.position.x, z: st!.position.z + st!.size.d / 2 + 0.5 };
  p.zone = interiorId;
  p.x = at.x;
  p.z = at.z;
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

/** Espèces seulement (solde propre de départ mis à 0) : tests du paiement en argent sale. */
function setCash(room: NarcoRoom, id: string, cash: number) {
  room.state.players.get(id)!.cleanBalance = 0;
  const r = add(
    emptyInventory(gameData.economy.bag.pocketSlots),
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
    goTo(room, 'shop-player-0001', 'shop', 'shelf_racks');
    expect((await act(client, 'shelf_racks', 'take')).ok).toBe(true);
    expect((await act(client, 'shelf_racks', 'take')).ok).toBe(true);
    goTo(room, 'shop-player-0001', 'shop', 'shelf_pots');
    expect((await act(client, 'shelf_pots', 'take')).ok).toBe(true);

    const p = room.state.players.get('shop-player-0001')!;
    const total = 2 * price('shelf_racks') + price('shelf_pots');
    expect(p.cartTotal).toBe(total);
    expect(stockOf(room, 'shop:shelf_pots')).toBe(
      shopShelves.find((s) => s.itemId === 'pot')!.stock! - 1,
    );

    goTo(room, 'shop-player-0001', 'shop', 'counter');
    const paid = await act(client, 'counter', 'pay');
    expect(paid.ok).toBe(true);
    const bag = bagOf(room, 'shop-player-0001');
    expect(count(bag, 'cash_dirty')).toBe(200 - total);
    expect(count(bag, 'drying_rack')).toBe(2);
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
    goTo(room, 'shop-player-0003', 'shop', 'shelf_racks');
    await act(client, 'shelf_racks', 'take');
    goTo(room, 'shop-player-0003', 'shop', 'counter');
    expect((await act(client, 'counter', 'pay')).text).toBe('Poches pleines : libère une case.');
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

describe('shop — deux monnaies', () => {
  const groceryPrice = (id: string) =>
    gameData.shops.get('grocery')!.shelves.find((s) => s.stationId === id)!.price;

  it('départ : 150 $ propres, 0 $ sale, pas de compte', async () => {
    const { room } = await newGame('shop-player-0010');
    const p = room.state.players.get('shop-player-0010')!;
    expect(count(bagOf(room, 'shop-player-0010'), 'cash_dirty')).toBe(0);
    expect(p.hasAccount).toBe(false);
    expect(p.cleanBalance).toBe(150);
  });

  it('« any » payé en propre sans compte si le solde couvre, en espèces sinon', async () => {
    const id = 'shop-player-0011';
    const { client, room } = await newGame(id);
    const p = room.state.players.get(id)!;
    goTo(room, id, 'grocery', 'shelf_food');
    await act(client, 'shelf_food', 'take');
    expect([p.cartDirty, p.cartClean]).toEqual([0, groceryPrice('shelf_food')]);
    goTo(room, id, 'grocery', 'counter');
    expect((await act(client, 'counter', 'pay')).text).toMatch(/par carte/);
    expect(p.cleanBalance).toBe(150 - groceryPrice('shelf_food'));
    expect(p.hasAccount).toBe(false);

    setCash(room, id, 50); // solde propre à 0, espèces seulement
    goTo(room, id, 'grocery', 'shelf_water');
    await act(client, 'shelf_water', 'take');
    expect([p.cartDirty, p.cartClean]).toEqual([groceryPrice('shelf_water'), 0]);
    goTo(room, id, 'grocery', 'counter');
    expect((await act(client, 'counter', 'pay')).text).toMatch(/en espèces/);
    expect(count(bagOf(room, id), 'cash_dirty')).toBe(50 - groceryPrice('shelf_water'));
    expect(count(bagOf(room, id), 'water')).toBe(1);
  });

  it('article « clean » payé sans compte ; panier mixte atomique', async () => {
    const id = 'shop-player-0012';
    const { client, room } = await newGame(id);
    const p = room.state.players.get(id)!;
    for (const shelf of ['shelf_tools', 'shelf_pots']) {
      goTo(room, id, 'shop', shelf);
      await act(client, shelf, 'take');
    }
    // propre : outils seulement (le pot « any » ne tient plus en plus) ; sale : le pot
    setCash(room, id, price('shelf_pots') - 1);
    p.cleanBalance = price('shelf_tools');
    goTo(room, id, 'shop', 'counter');
    expect((await act(client, 'counter', 'pay')).text).toMatch(/Pas assez d'argent sale/);
    expect(p.cleanBalance).toBe(price('shelf_tools'));
    setCash(room, id, price('shelf_pots'));
    p.cleanBalance = price('shelf_tools');
    expect((await act(client, 'counter', 'pay')).ok).toBe(true);
    expect(p.cleanBalance).toBe(0);
    expect(p.hasAccount).toBe(false);
    expect(count(bagOf(room, id), 'cash_dirty')).toBe(0);
    expect(count(bagOf(room, id), 'scissors')).toBe(1);
    expect(count(bagOf(room, id), 'pot')).toBe(1);
  });

  it('Bricoshop sans graines ni sac à dos : le sac est chez Momo', () => {
    const items = shopShelves.map((s) => gameData.items.get(s.itemId)!.category);
    expect(items).not.toContain('seed');
    expect(shopShelves.some((s) => s.itemId === 'sac_a_dos')).toBe(false);
    const momo = gameData.shops.get('grocery')!.shelves;
    expect(momo.find((s) => s.stationId === 'shelf_bags')!.itemId).toBe('sac_a_dos');
  });

  it('ancienne sauvegarde : panier sans monnaie chargé, payé en espèces', () => {
    const old = {
      id: 'old',
      name: 'Ancien',
      color: '#ffffff',
      x: 0,
      z: 0,
      cart: [{ stationId: 'shelf_pots', itemId: 'pot', qty: 2, unitPrice: 15 }],
      cartTotal: 30,
    };
    const snap = RoomSnapshotSchema.parse({
      code: 'ABCD',
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      savedAt: 0,
      clock: { now: 0, scale: 1 },
      state: { ...new GameState().toJSON(), code: 'ABCD', players: { old } },
    });
    const state = new GameState();
    hydrateState(state, snap);
    const p = state.players.get('old')!;
    expect(p.cart[0]!.currency).toBe('dirty');
    expect([p.cartTotal, p.cartDirty, p.cartClean]).toEqual([30, 30, 0]);
  });

  it('debug : donne de l’argent propre et de l’argent sale', async () => {
    const id = 'shop-player-0013';
    const { client, room } = await newGame(id);
    client.send(ClientMsg.Debug, { cmd: 'giveClean', amount: 300 });
    await client.waitForMessage(ServerMsg.Notice);
    client.send(ClientMsg.Debug, { cmd: 'money', amount: 50 });
    await client.waitForMessage(ServerMsg.Notice);
    expect(room.state.players.get(id)!.cleanBalance).toBe(150 + 300);
    expect(count(bagOf(room, id), 'cash_dirty')).toBe(50);
  });
});

describe('shop → labo', () => {
  it('partie neuve, 150 $ : achat au Bricoshop, placement libre, cycle jusqu’aux pochons', async () => {
    const { client, room } = await newGame('shop-player-0007');
    client.send(ClientMsg.Debug, { cmd: 'timeScale', scale: 60 });
    await client.waitForMessage(ServerMsg.Notice);
    expect(room.state.lab.fixtures.size).toBe(0);
    const me = room.state.players.get('shop-player-0007')!;
    expect(me.cleanBalance).toBe(150);
    // kit minimal, payé avec l'argent propre de départ, sans compte
    for (const shelf of ['shelf_pots', 'shelf_racks', 'shelf_tables', 'shelf_lamps']) {
      goTo(room, 'shop-player-0007', 'shop', shelf);
      expect((await act(client, shelf, 'take')).ok).toBe(true);
    }
    goTo(room, 'shop-player-0007', 'shop', 'counter');
    expect((await act(client, 'counter', 'pay')).ok).toBe(true);
    // graines : seulement chez El Jefe (pacte)
    Object.assign(me, {
      zone: 'street',
      ...interactionPoint(gameData.locations.get('repaire_jefe')!),
    });
    client.send(ClientMsg.Interact, { locationId: 'repaire_jefe' });
    await client.waitForMessage(ServerMsg.Dialogue);
    client.send(ClientMsg.DialogueChoose, {
      dialogueId: 'el_jefe',
      nodeId: 'welcome',
      choiceId: 'accept',
    });
    await Promise.all([
      client.waitForMessage(ServerMsg.Notice),
      client.waitForMessage(ServerMsg.Dialogue),
    ]);
    const bag = bagOf(room, 'shop-player-0007');
    for (const id of ['pot', 'drying_rack', 'cutting_table', 'grow_lamp'])
      expect(count(bag, id)).toBe(1);
    expect(count(bag, 'seed_base')).toBe(gameData.economy.pact.startSeeds);

    // dans le labo, le joueur pose chaque meuble où il veut (près du robinet)
    goTo(room, 'shop-player-0007', 'lab', 'water');
    let requestId = 1;
    const place = async (itemId: string, x: number, z: number, rot = 0) => {
      const msg: FixturePlaceMessage = { requestId: requestId++, itemId, x, z, rot };
      client.send(ClientMsg.FixturePlace, msg);
      const r = (await client.waitForMessage(ServerMsg.FixtureResult)) as FixtureResultMessage;
      expect(r.ok, r.text).toBe(true);
      expect(r.requestId).toBe(msg.requestId);
      return r.fixtureId!;
    };
    const pot = await place('pot', -3, -2);
    // sans lampe à portée : refus clair
    goTo(room, 'shop-player-0007', 'lab', pot);
    expect((await act(client, pot, 'plant')).text).toBe(NO_LAMP);
    goTo(room, 'shop-player-0007', 'lab', 'water');
    await place('grow_lamp', -3, -2); // au-dessus du pot
    const rack = await place('drying_rack', 1.8, -3.4);
    const table = await place('cutting_table', 4.4, 0.4, 1);
    expect(room.state.lab.fixtures.size).toBe(4);
    expect(room.state.lab.fixtures.get(table)!.rot).toBe(1);
    const left = bagOf(room, 'shop-player-0007');
    for (const id of ['pot', 'drying_rack', 'cutting_table']) expect(count(left, id)).toBe(0);

    const retry = async (stationId: string, action: StationAction) => {
      let n = await act(client, stationId, action);
      while (!n.ok) {
        await new Promise((r) => setTimeout(r, 150));
        n = await act(client, stationId, action);
      }
    };
    goTo(room, 'shop-player-0007', 'lab', pot);
    expect((await act(client, pot, 'plant')).ok).toBe(true);
    for (let i = 0; i < Math.ceil(strain.growSeconds / strain.waterEverySeconds); i++) {
      goTo(room, 'shop-player-0007', 'lab', 'water');
      await act(client, 'water', 'fill');
      goTo(room, 'shop-player-0007', 'lab', pot);
      await retry(pot, 'water');
    }
    await retry(pot, 'harvest');
    goTo(room, 'shop-player-0007', 'lab', rack);
    await retry(rack, 'hang');
    await retry(rack, 'collect');
    goTo(room, 'shop-player-0007', 'lab', table);
    await retry(table, 'cut');
    await client.waitForMessage(ServerMsg.Notice);
    expect(count(bagOf(room, 'shop-player-0007'), 'pouch_base')).toBe(
      strain.freshPerPlant * strain.pouchesPerDried,
    );
  }, 20000);
});
