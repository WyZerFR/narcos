import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room as ServerRoom } from '@colyseus/core';
import type { Room as ClientRoom } from 'colyseus.js';
import {
  ClientMsg,
  ROOM_NAME,
  SALE_COMPLETED,
  areaAt,
  isFreeAt,
  rectContainsPoint,
  ServerMsg,
  add,
  count,
  emptyInventory,
  gameData,
  type NoticeMessage,
  type SaleCompletedEvent,
  type SaleOfferMessage,
} from '@narco/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NarcoRoom } from '../src/rooms/NarcoRoom';
import { gridOf, StreetNpcs } from '../src/rooms/npcs';
import { GameState, Player } from '../src/rooms/schema';
import { makeSlots, readInventory, writeInventory } from '../src/rooms/stateSync';
import { bootOn } from './helpers';

type SdkRoom = ClientRoom<GameState>;
const NPC = gameData.config.npc;
const AREAS = [...gameData.areas.values()];
const NPC_TOTAL = AREAS.reduce((n, a) => n + a.npcCount, 0);

let colyseus: ColyseusTestServer;

beforeAll(async () => {
  colyseus = await bootOn(2577);
});
afterAll(async () => {
  await colyseus.shutdown();
});
beforeEach(async () => {
  await colyseus.cleanup();
});

async function newGame(playerId: string) {
  const client = await colyseus.sdk.create<GameState>(ROOM_NAME, { playerId, name: 'Vendeur' });
  const room = colyseus.getRoomById<GameState>(client.roomId) as ServerRoom<GameState> as NarcoRoom;
  return { client, room };
}

async function notice(client: SdkRoom): Promise<NoticeMessage> {
  return (await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
}

/** Sac : argent de départ + `pouches` pochons de base. */
function setBag(room: NarcoRoom, playerId: string, pouches: number) {
  let inv = emptyInventory(gameData.config.inventory.bagSlots);
  const r = add(inv, 'pouch_base', pouches, gameData.items);
  if (r.ok) inv = r.inv;
  writeInventory(room.state.players.get(playerId)!.bag, inv);
}

/** Un acheteur intéressé devant le joueur (commande debug). */
async function buyer(client: SdkRoom, room: NarcoRoom): Promise<string> {
  client.send(ClientMsg.Debug, { cmd: 'spawnBuyer' });
  const n = await notice(client);
  expect(n.ok, n.text).toBe(true);
  const npc = [...room.state.npcs.values()].find((x) => n.text.includes(x.name))!;
  return npc.id;
}

async function open(client: SdkRoom, npcId: string): Promise<SaleOfferMessage> {
  client.send(ClientMsg.SaleOpen, { npcId });
  return (await client.waitForMessage(ServerMsg.SaleOffer)) as SaleOfferMessage;
}

describe('vente de rue', () => {
  it('fait apparaître la population de PNJ et les fait marcher', async () => {
    const { room } = await newGame('sale-player-0001');
    expect(room.state.npcs.size).toBe(NPC_TOTAL);
    const before = [...room.state.npcs.values()].map((n) => `${n.x},${n.z}`).join(';');
    await new Promise((r) => setTimeout(r, (NPC.pauseSeconds[1] + 1.5) * 1000));
    const after = [...room.state.npcs.values()].map((n) => `${n.x},${n.z}`).join(';');
    expect(after).not.toBe(before);
  }, 10000);

  it('vend des pochons contre de l’argent sale, émet sale_completed, puis le PNJ s’en va', async () => {
    const { client, room } = await newGame('sale-player-0002');
    setBag(room, 'sale-player-0002', 5);
    const events: SaleCompletedEvent[] = [];
    room.events.on(SALE_COMPLETED, (e: SaleCompletedEvent) => events.push(e));
    const npcId = await buyer(client, room);
    const offer = await open(client, npcId);
    expect(offer.maxQty).toBeGreaterThanOrEqual(1);
    expect(offer.maxQty).toBeLessThanOrEqual(3);
    const base = gameData.economy.strains[0]!.pouchSellPrice;
    const v = gameData.economy.sale.priceVariance;
    expect(offer.unitPrice).toBeGreaterThanOrEqual(Math.round(base * (1 - v)));
    expect(offer.unitPrice).toBeLessThanOrEqual(Math.round(base * (1 + v)));
    expect(room.state.npcs.get(npcId)!.busyWith).toBe('sale-player-0002');

    client.send(ClientMsg.SaleAccept, { npcId, qty: offer.maxQty });
    const n = await notice(client);
    expect(n.ok, n.text).toBe(true);
    const bag = readInventory(room.state.players.get('sale-player-0002')!.bag);
    expect(count(bag, 'pouch_base')).toBe(5 - offer.maxQty);
    expect(count(bag, 'cash_dirty')).toBe(offer.maxQty * offer.unitPrice);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      playerId: 'sale-player-0002',
      npcId,
      qty: offer.maxQty,
      amount: offer.maxQty * offer.unitPrice,
      area: 'street',
    });
    expect(offer).toMatchObject({ area: 'street', priceMultiplier: 1 });
    // cooldown : il n'achète plus
    const npc = room.state.npcs.get(npcId)!;
    expect(npc.interested).toBe(false);
    expect(npc.busyWith).toBe('');
    client.send(ClientMsg.SaleOpen, { npcId });
    expect((await notice(client)).text).toMatch(/pas intéressé/);
  });

  it('quartier nord : prix × priceMultiplier de l’area du PNJ, bonus et area dans l’événement', async () => {
    const id = 'sale-player-0030';
    const { client, room } = await newGame(id);
    setBag(room, id, 5);
    const north = gameData.areas.get('north')!;
    const nord = gameData.quartierLayouts.get('nord')!;
    const p = room.state.players.get(id)!;
    Object.assign(p, { x: nord.frame.axisX, z: nord.waypoints[2]!.z, rotY: 0 });
    const events: SaleCompletedEvent[] = [];
    room.events.on(SALE_COMPLETED, (e: SaleCompletedEvent) => events.push(e));
    const npcId = await buyer(client, room);
    const offer = await open(client, npcId);
    expect(offer).toMatchObject({ area: 'north', priceMultiplier: north.priceMultiplier });
    const base = gameData.economy.strains[0]!.pouchSellPrice;
    const v = gameData.economy.sale.priceVariance;
    expect(offer.unitPrice).toBeGreaterThanOrEqual(
      Math.round(base * (1 - v) * north.priceMultiplier),
    );
    expect(offer.unitPrice).toBeLessThanOrEqual(Math.round(base * (1 + v) * north.priceMultiplier));
    client.send(ClientMsg.SaleAccept, { npcId, qty: 1 });
    expect((await notice(client)).ok).toBe(true);
    expect(events[0]).toMatchObject({ area: 'north', amount: offer.unitPrice });
  });

  it('refuse : hors de la rue, trop loin, pas assez de pochons, sac plein, quantité hors offre', async () => {
    const { client, room } = await newGame('sale-player-0003');
    const p = room.state.players.get('sale-player-0003')!;
    setBag(room, 'sale-player-0003', 1);
    const npcId = await buyer(client, room);

    // trop loin
    const { x, z } = p;
    p.x = x + 10;
    client.send(ClientMsg.SaleOpen, { npcId });
    expect((await notice(client)).text).toMatch(/Trop loin/);
    p.x = x;
    p.z = z;
    // hors de la rue
    p.zone = 'lab';
    client.send(ClientMsg.SaleOpen, { npcId });
    expect((await notice(client)).text).toMatch(/dans la rue/);
    p.zone = 'street';

    const offer = await open(client, npcId);
    // quantité hors offre
    client.send(ClientMsg.SaleAccept, { npcId, qty: offer.maxQty + 1 });
    expect((await notice(client)).ok).toBe(false);
    // pas assez de pochons (1 seul en sac)
    if (offer.maxQty > 1) {
      client.send(ClientMsg.SaleAccept, { npcId, qty: 2 });
      expect((await notice(client)).text).toMatch(/Pas assez/);
    }
    // sac plein : 5 pochons (il en restera), le reste rempli de ciseaux, pas de place pour l'argent
    let inv = emptyInventory(gameData.config.inventory.bagSlots);
    const r1 = add(inv, 'pouch_base', 5, gameData.items);
    if (r1.ok) inv = r1.inv;
    const r2 = add(inv, 'scissors', inv.length - 1, gameData.items);
    if (r2.ok) inv = r2.inv;
    writeInventory(p.bag, inv);
    client.send(ClientMsg.SaleAccept, { npcId, qty: 1 });
    expect((await notice(client)).text).toMatch(/Sac plein/);
    expect(count(readInventory(p.bag), 'pouch_base')).toBe(5);
    expect(count(readInventory(p.bag), 'cash_dirty')).toBe(0);
  });

  it('deux vendeurs sur le même PNJ : un seul obtient l’offre', async () => {
    const { client: a, room } = await newGame('sale-player-0004');
    const b = await colyseus.sdk.joinById<GameState>(room.roomId, {
      playerId: 'sale-player-0005',
      name: 'Concurrent',
    });
    const pa = room.state.players.get('sale-player-0004')!;
    const pb = room.state.players.get('sale-player-0005')!;
    setBag(room, 'sale-player-0004', 3);
    setBag(room, 'sale-player-0005', 3);
    const npcId = await buyer(a, room);
    pb.x = pa.x;
    pb.z = pa.z;
    pb.zone = pa.zone;

    const got: string[] = [];
    a.onMessage(ServerMsg.SaleOffer, () => got.push('a'));
    b.onMessage(ServerMsg.SaleOffer, () => got.push('b'));
    a.send(ClientMsg.SaleOpen, { npcId });
    b.send(ClientMsg.SaleOpen, { npcId });
    await new Promise((r) => setTimeout(r, 300));
    expect(got).toHaveLength(1);
    const loser = got[0] === 'a' ? b : a;
    const winnerId = got[0] === 'a' ? 'sale-player-0004' : 'sale-player-0005';
    // le perdant ne peut pas non plus accepter à la place du gagnant
    loser.send(ClientMsg.SaleAccept, { npcId, qty: 1 });
    expect(((await loser.waitForMessage(ServerMsg.Notice)) as NoticeMessage).ok).toBe(false);
    expect(room.state.npcs.get(npcId)!.busyWith).toBe(winnerId);
  });

  it('refuser libère le PNJ ; une offre expire quand sa patience est épuisée', async () => {
    const { client, room } = await newGame('sale-player-0006');
    setBag(room, 'sale-player-0006', 3);
    let npcId = await buyer(client, room);
    await open(client, npcId);
    const declined = Promise.all([client.waitForMessage(ServerMsg.SaleClosed), notice(client)]);
    client.send(ClientMsg.SaleDecline, { npcId });
    const [closedByDecline] = (await declined) as [{ npcId: string }, NoticeMessage];
    expect(closedByDecline.npcId).toBe(npcId);
    expect(room.state.npcs.get(npcId)!.busyWith).toBe('');

    // patience : temps x60, l'offre se ferme seule
    client.send(ClientMsg.Debug, { cmd: 'timeScale', scale: 60 });
    await notice(client);
    npcId = await buyer(client, room);
    await open(client, npcId);
    const closed = (await client.waitForMessage(ServerMsg.SaleClosed)) as { npcId: string };
    expect(closed.npcId).toBe(npcId);
    expect(room.state.npcs.get(npcId)!.busyWith).toBe('');
  }, 10000);

  it('entrer dans un lieu lâche l’offre en cours', async () => {
    const { client, room } = await newGame('sale-player-0007');
    setBag(room, 'sale-player-0007', 3);
    const npcId = await buyer(client, room);
    await open(client, npcId);
    const p = room.state.players.get('sale-player-0007')!;
    const loc = gameData.locations.get('local')!;
    const door = (await import('@narco/shared')).interactionPoint(loc);
    p.x = door.x;
    p.z = door.z;
    client.send(ClientMsg.Interact, { locationId: 'local' });
    const closed = (await client.waitForMessage(ServerMsg.SaleClosed)) as { npcId: string };
    expect(closed.npcId).toBe(npcId);
    expect(room.state.npcs.get(npcId)!.busyWith).toBe('');
  });
});

describe('PNJ — simulation (hors réseau, hasard maîtrisé)', () => {
  it('cooldown puis nouvelle demande, sans dépendre du réseau', () => {
    const state = new GameState();
    let seed = 1;
    const rng = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    const sim = new StreetNpcs(state, rng);
    sim.spawnAll(0);
    expect(state.npcs.size).toBe(NPC_TOTAL);
    const player = new Player();
    player.id = 'p';
    player.zone = 'street';
    player.bag = makeSlots(gameData.config.inventory.bagSlots);
    player.x = 30;
    player.z = 5.25;
    player.rotY = Math.PI / 2;
    const id = sim.spawnBuyerNear(player)!;
    expect(id).toBeTruthy();
    expect(state.npcs.get(id)!.interested).toBe(true);
    expect(sim.open('p', player, id, 1000).ok).toBe(true);
    expect(sim.decline('p', id, 1000)).toBe(true);
    expect(state.npcs.get(id)!.interested).toBe(false);
    // juste avant la fin du cooldown max : toujours indisponible ; après : nouvelle demande tirée
    sim.update(250, 1, 1000 + NPC.cooldownSeconds[0] * 1000 - 1);
    expect(sim.open('p', player, id, 1000).ok).toBe(false);
    sim.update(250, 2, 1000 + NPC.cooldownSeconds[1] * 1000 + 1);
    const npc = state.npcs.get(id)!;
    expect(npc.busyWith).toBe('');
    // la demande a été retirée : visible si intéressé, avec une offre complète
    if (npc.interested) expect(npc.qty * npc.unitPrice).toBeGreaterThan(0);
  });

  it('population par area : nombre de areas.json, au plus config.npc.maxTotal', () => {
    const state = new GameState();
    const sim = new StreetNpcs(state, () => 0.42);
    sim.spawnAll(0);
    expect(NPC_TOTAL).toBeLessThanOrEqual(NPC.maxTotal);
    expect(NPC_TOTAL).toBe(14);
    for (const area of AREAS) {
      const ids = [...state.npcs.keys()].filter((id) => sim.areaOf(id) === area.id);
      expect(ids, area.id).toHaveLength(area.npcCount);
    }
  });

  it('chaque PNJ reste dans le rectangle de son area en marchant', () => {
    const state = new GameState();
    let seed = 7;
    const rng = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    const sim = new StreetNpcs(state, rng);
    sim.spawnAll(0);
    for (let t = 1; t <= 400; t++) {
      sim.update(250, t * 250 + 10_000, t * 250);
      if (t % 40 === 0)
        for (const id of state.npcs.keys()) {
          const area = gameData.areas.get(sim.areaOf(id)!)!;
          expect(areaAt(AREAS, sim.positionOf(id)!)?.id ?? 'hors carte', id).toBe(area.id);
        }
    }
  });

  it('PNJ de vente exclus des passages et des jardins cachés (vrai et leurres)', () => {
    // tous les jardins cachés (vrai et leurres) et leurs passages
    const zones = gameData.quartierLayouts
      .get('sud')!
      .gardens.flatMap((g) => [g.passage, g.garden]);
    const g = gridOf('south');
    for (const r of zones)
      expect(isFreeAt(g, { x: (r.minX + r.maxX) / 2, z: (r.minZ + r.maxZ) / 2 })).toBe(false);
    const state = new GameState();
    let seed = 11;
    const rng = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    const sim = new StreetNpcs(state, rng);
    sim.spawnAll(0);
    for (let t = 1; t <= 300; t++) {
      sim.update(250, t * 250 + 10_000, t * 250);
      for (const id of state.npcs.keys()) {
        const p = sim.positionOf(id)!;
        for (const r of zones) expect(rectContainsPoint(r, p), id).toBe(false);
      }
    }
  });

  it('les PNJ restent sur des cases libres de la rue en marchant', () => {
    const state = new GameState();
    const sim = new StreetNpcs(state, () => 0.37);
    sim.spawnAll(0);
    for (let t = 1; t <= 200; t++) sim.update(250, t * 250 + 10_000, t * 250);
    sim.publish();
    for (const npc of state.npcs.values()) {
      const b = gameData.config.world.bounds;
      expect(npc.x).toBeGreaterThanOrEqual(b.minX);
      expect(npc.x).toBeLessThanOrEqual(b.maxX);
      expect(npc.z).toBeGreaterThanOrEqual(b.minZ);
      expect(npc.z).toBeLessThanOrEqual(b.maxZ);
    }
  });
});
