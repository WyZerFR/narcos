import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room as ServerRoom } from '@colyseus/core';
import {
  ClientMsg,
  ROOM_NAME,
  ServerMsg,
  STREET,
  add,
  count,
  emptyInventory,
  gameData,
  maxBurstMeters,
  type NoticeMessage,
} from '@narco/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NarcoRoom } from '../src/rooms/NarcoRoom';
import type { GameState } from '../src/rooms/schema';
import { readInventory, writeInventory } from '../src/rooms/stateSync';
import { bootOn } from './helpers';

const rules = gameData.economy.survival;
const MIN = 60_000;
/** Attente d'au moins une mise à jour des jauges (toutes les secondes côté serveur). */
const settle = () => new Promise((r) => setTimeout(r, 1200));

let colyseus: ColyseusTestServer;

beforeAll(async () => {
  colyseus = await bootOn(2574);
});
afterAll(async () => {
  await colyseus.shutdown();
});
beforeEach(async () => {
  await colyseus.cleanup();
});

async function newGame(playerId: string) {
  const client = await colyseus.sdk.create<GameState>(ROOM_NAME, { playerId, name: 'Affamé' });
  const room = colyseus.getRoomById<GameState>(client.roomId) as ServerRoom<GameState> as NarcoRoom;
  return { client, room, p: room.state.players.get(playerId)! };
}

describe('survie côté serveur', () => {
  it('démarre aux valeurs configurées et baisse au rythme configuré', async () => {
    const { room, p } = await newGame('surv-player-0001');
    expect(p.hunger).toBe(rules.start.hunger);
    p.survivalAt = room.now() - 10 * MIN; // 10 minutes de jeu écoulées
    await settle();
    expect(p.hunger).toBeCloseTo(rules.start.hunger - 10 * rules.hungerPerMinute, 0);
    expect(p.thirst).toBeCloseTo(rules.start.thirst - 10 * rules.thirstPerMinute, 0);
  });

  it('ne baisse pas pendant la déconnexion', async () => {
    const { client, room, p } = await newGame('surv-player-0002');
    await client.leave(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(p.connected).toBe(false);
    const before = p.hunger; // soldé au moment du départ
    p.survivalAt = room.now() - 30 * MIN; // même si l'horodatage est ancien…
    await settle();
    expect(p.hunger).toBe(before); // … personne ne met à jour un joueur hors ligne
    await colyseus.sdk.joinById(room.roomId, { playerId: 'surv-player-0002' });
    await settle();
    expect(p.hunger).toBeGreaterThan(before - 1); // reconnexion : on repart de maintenant
  });

  it('ralentit le joueur sous le seuil bas', async () => {
    const { client, p } = await newGame('surv-player-0003');
    p.hunger = rules.lowThreshold - 1;
    const reduced =
      maxBurstMeters({
        maxSpeed: gameData.config.movement.runSpeed * rules.lowSpeedFactor,
        toleranceFactor: gameData.config.movement.toleranceFactor,
        maxBurstMs: gameData.config.movement.maxBurstMs,
        bounds: gameData.config.world.bounds,
      }) + 0.2;
    const start = { x: p.x, z: p.z };
    client.send(ClientMsg.Move, { zone: STREET, x: start.x - 5.5, z: start.z, rotY: 0, seq: 1 });
    await client.waitForMessage(ServerMsg.Correction);
    expect(Math.hypot(p.x - start.x, p.z - start.z)).toBeLessThan(reduced);
  });

  it('KO : réapparition au carton, jauges de reprise et perte d’argent sale', async () => {
    const { client, room, p } = await newGame('surv-player-0004');
    const r = add(emptyInventory(p.bag.length), 'cash_dirty', 100, gameData.items);
    if (r.ok) writeInventory(p.bag, r.inv);
    p.zone = 'grocery';
    p.x = 0;
    p.z = 0;
    Object.assign(p, { hunger: 0, thirst: 0, health: 1 });
    p.survivalAt = room.now() - MIN;
    const notice = (await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
    expect(notice.text).toMatch(/KO/);
    expect(p.zone).toBe(STREET);
    const spawn = gameData.config.players.spawn;
    expect(Math.hypot(p.x - spawn.x, p.z - spawn.z)).toBeLessThan(1);
    expect({ hunger: p.hunger, thirst: p.thirst, health: p.health }).toEqual(rules.koRecovery);
    expect(count(readInventory(p.bag), 'cash_dirty')).toBe(
      100 - Math.floor((100 * rules.koDirtyCashLossPercent) / 100),
    );
  });

  it('manger / boire restaure, plafonné à 100, et consomme l’objet', async () => {
    const { client, p } = await newGame('surv-player-0005');
    const r = add(readInventory(p.bag), 'water', 2, gameData.items);
    if (r.ok) writeInventory(p.bag, r.inv);
    p.thirst = 90;
    const slot = readInventory(p.bag).findIndex((s) => s?.itemId === 'water');
    client.send(ClientMsg.Use, { slot });
    expect(((await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage).ok).toBe(true);
    expect(p.thirst).toBe(rules.max);
    expect(count(readInventory(p.bag), 'water')).toBe(1);
    const seedSlot = readInventory(p.bag).findIndex((s) => s?.itemId === 'cash_dirty');
    client.send(ClientMsg.Use, { slot: seedSlot });
    expect(((await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage).ok).toBe(false);
  });

  it('accélère la survie seule en debug', async () => {
    const { client, room, p } = await newGame('surv-player-0006');
    client.send(ClientMsg.Debug, { cmd: 'survivalScale', scale: 60 });
    await client.waitForMessage(ServerMsg.Notice);
    expect(room.state.clock.survivalScale).toBe(60);
    expect(room.state.clock.scale).toBe(1);
    await settle();
    await settle();
    expect(p.hunger).toBeLessThan(rules.start.hunger - rules.hungerPerMinute); // > 1 min de jeu
  });
});
