import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room as ServerRoom } from '@colyseus/core';
import type { Room as ClientRoom } from 'colyseus.js';
import { matchMaker } from '@colyseus/core';
import {
  ClientMsg,
  ROOM_NAME,
  ServerMsg,
  count,
  gameData,
  type NoticeMessage,
  type StationAction,
} from '@narco/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NarcoRoom } from '../src/rooms/NarcoRoom';
import type { GameState } from '../src/rooms/schema';
import { readInventory, writeInventory } from '../src/rooms/stateSync';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { RoomSnapshotSchema, SNAPSHOT_SCHEMA_VERSION, readSnapshotFile } from '../src/persistence';
import { bootOn, frontOf, furnish } from './helpers';

/** Alias de l'agencement de test → id réel du meuble posé (les postes fixes gardent le leur). */
let ids: Record<string, string> = {};
const sid = (name: string) => ids[name] ?? name;
/** Pose l'agencement de test (ou une partie), avec la validation des joueurs. */
const equip = (room: NarcoRoom, names?: Parameters<typeof furnish>[1]) => {
  ids = furnish(room, names);
};
const strain = gameData.economy.strains.find((s) => s.id === 'base')!;

let colyseus: ColyseusTestServer;

beforeAll(async () => {
  colyseus = await bootOn(2572);
});
afterAll(async () => {
  await colyseus.shutdown();
});
beforeEach(async () => {
  await colyseus.cleanup();
});

type SdkRoom = ClientRoom<GameState>;

async function newGame(playerId: string) {
  const client = await colyseus.sdk.create<GameState>(ROOM_NAME, { playerId, name: 'Chimiste' });
  const room = colyseus.getRoomById<GameState>(client.roomId) as ServerRoom<GameState> as NarcoRoom;
  return { client, room };
}

async function join(room: NarcoRoom, playerId: string) {
  return colyseus.sdk.joinById<GameState>(room.roomId, { playerId, name: 'Associé' });
}

/** Place un joueur dans le labo, juste devant un poste (positionnement direct, côté serveur). */
function goTo(room: NarcoRoom, playerId: string, stationId: string) {
  const p = room.state.players.get(playerId)!;
  const at = frontOf(stationId);
  p.zone = 'lab';
  p.x = at.x;
  p.z = at.z;
}

async function act(
  client: SdkRoom,
  stationId: string,
  action: StationAction,
): Promise<NoticeMessage> {
  client.send(ClientMsg.Station, { stationId: sid(stationId), action });
  return (await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
}

const bagOf = (room: NarcoRoom, playerId: string) =>
  readInventory(room.state.players.get(playerId)!.bag);

describe('labo — validation des actions', () => {
  it('démarre avec un labo vide et sans stock commun', async () => {
    const { room } = await newGame('lab-player-0001');
    expect('stock' in room.state.lab.toJSON()).toBe(false);
    expect(room.state.lab.fixtures.size).toBe(0);
    expect(room.state.lab.pots.size).toBe(0);
    expect(room.state.players.get('lab-player-0001')!.bag.length).toBe(
      gameData.economy.inventory.bagSlots,
    );
  });

  it('donne l’argent de départ (1000 $ sale, temporaire) dans le sac', async () => {
    const { room } = await newGame('lab-player-0011');
    const { dirty, clean } = gameData.economy.startingMoney;
    expect(dirty).toBe(1000);
    const p = room.state.players.get('lab-player-0011')!;
    expect(count(readInventory(p.bag), 'cash_dirty')).toBe(dirty);
    expect(p.cleanMoney).toBe(clean);
  });

  it('refuse depuis la rue, de trop loin et sans objet', async () => {
    const { client, room } = await newGame('lab-player-0002');
    expect((await act(client, 'pot_1', 'plant')).ok).toBe(false); // dans la rue
    const p = room.state.players.get('lab-player-0002')!;
    p.zone = 'lab';
    goTo(room, 'lab-player-0002', 'pot_1');
    expect((await act(client, 'pot_1', 'plant')).text).toMatch(/pas ici/); // rien de posé
    equip(room);
    p.x = 6;
    p.z = 4;
    expect((await act(client, 'pot_1', 'plant')).text).toMatch(/Trop loin/);
    goTo(room, 'lab-player-0002', 'pot_1');
    expect((await act(client, 'pot_1', 'plant')).text).toMatch(/graine/);
    expect((await act(client, 'pot_1', 'cut')).ok).toBe(false); // mauvaise action pour ce poste
  });

  it('fin de découpe sac plein : refus clair une seule fois, pochons livrés dès qu’il y a de la place', async () => {
    const { client, room } = await newGame('lab-player-0003');
    equip(room);
    const p = room.state.players.get('lab-player-0003')!;
    const full = Array.from({ length: p.bag.length }, () => ({ itemId: 'food', qty: 1 }));
    writeInventory(p.bag, full);
    const cut = room.state.lab.cuts.get(sid('table_1'))!;
    Object.assign(cut, { playerId: p.id, strainId: 'base', qty: 2, readyAt: room.now() });
    const refused = (await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
    expect(refused.ok).toBe(false);
    expect(refused.text).toMatch(/sac plein/i);
    expect(cut.qty).toBe(2); // la découpe attend sur la table
    const notices: NoticeMessage[] = [];
    client.onMessage(ServerMsg.Notice, (n: NoticeMessage) => notices.push(n));
    await new Promise((r) => setTimeout(r, 300));
    expect(notices).toHaveLength(0); // pas de répétition à chaque tick
    writeInventory(p.bag, [null, ...full.slice(1)]);
    while (notices.length === 0) await new Promise((r) => setTimeout(r, 20));
    expect(notices[0]).toMatchObject({ ok: true });
    expect(count(readInventory(p.bag), 'pouch_base')).toBe(2 * strain.pouchesPerDried);
    expect(readInventory(p.bag)).toHaveLength(p.bag.length);
    expect(cut.playerId).toBe('');
  });
});

describe('labo — production', () => {
  it('double récolte simultanée : un seul gagne', async () => {
    const { client: a, room } = await newGame('lab-player-0006');
    const b = await join(room, 'lab-player-0007');
    equip(room);
    const pot = room.state.lab.pots.get(sid('pot_1'))!;
    // pot prêt : planté et arrosé suffisamment longtemps dans le passé
    const now = room.now();
    Object.assign(pot, {
      planted: true,
      strainId: 'base',
      growMsDone: strain.growSeconds * 1000,
      bankedAt: now,
      wateredUntil: now,
    });
    goTo(room, 'lab-player-0006', 'pot_1');
    goTo(room, 'lab-player-0007', 'pot_1');
    a.send(ClientMsg.Station, { stationId: sid('pot_1'), action: 'harvest' });
    b.send(ClientMsg.Station, { stationId: sid('pot_1'), action: 'harvest' });
    const [na, nb] = (await Promise.all([
      a.waitForMessage(ServerMsg.Notice),
      b.waitForMessage(ServerMsg.Notice),
    ])) as NoticeMessage[];
    expect([na!.ok, nb!.ok].filter(Boolean)).toHaveLength(1);
    const fresh = (id: string) => count(bagOf(room, id), 'plant_fresh_base');
    expect(fresh('lab-player-0006') + fresh('lab-player-0007')).toBe(strain.freshPerPlant);
    expect(pot.planted).toBe(false);
  });

  it('cycle complet graine → pochon, à plusieurs, horloge x60', async () => {
    const { client: a, room } = await newGame('lab-player-0008');
    const b = await join(room, 'lab-player-0009');
    a.send(ClientMsg.Debug, { cmd: 'timeScale', scale: 60 });
    await a.waitForMessage(ServerMsg.Notice);
    // équiper depuis la rue est refusé, depuis le labo accepté
    a.send(ClientMsg.Debug, { cmd: 'equipLab' });
    expect(((await a.waitForMessage(ServerMsg.Notice)) as NoticeMessage).ok).toBe(false);
    goTo(room, 'lab-player-0008', 'water');
    a.send(ClientMsg.Debug, { cmd: 'equipLab' });
    expect(((await a.waitForMessage(ServerMsg.Notice)) as NoticeMessage).ok).toBe(true);
    const kit = Object.values(gameData.config.debug.equipKit).reduce((a, b) => a + b, 0);
    expect(room.state.lab.fixtures.size).toBe(kit);
    // puis agencement connu, sans lampes : vitesse de pousse normale, arrosages comptés
    a.send(ClientMsg.Debug, { cmd: 'clearLab' });
    expect(((await a.waitForMessage(ServerMsg.Notice)) as NoticeMessage).ok).toBe(true);
    expect(room.state.lab.fixtures.size).toBe(0);
    equip(room, ['pot_1', 'rack_2', 'table_1']);

    // A prend une graine (debug) et plante
    a.send(ClientMsg.Debug, { cmd: 'give', itemId: 'seed_base', qty: 1 });
    await a.waitForMessage(ServerMsg.Notice);
    goTo(room, 'lab-player-0008', 'pot_1');
    expect((await act(a, 'pot_1', 'plant')).ok).toBe(true);

    // B remplit une bouteille et arrose, autant de fois que nécessaire
    const waterings = Math.ceil(strain.growSeconds / strain.waterEverySeconds);
    for (let i = 0; i < waterings; i++) {
      goTo(room, 'lab-player-0009', 'water');
      expect((await act(b, 'water', 'fill')).ok).toBe(true);
      goTo(room, 'lab-player-0009', 'pot_1');
      let n = await act(b, 'pot_1', 'water');
      while (!n.ok && /humide/.test(n.text)) {
        await new Promise((r) => setTimeout(r, 200));
        n = await act(b, 'pot_1', 'water');
      }
      expect(n.ok).toBe(true);
    }

    // A récolte dès que c'est prêt
    let h = await act(a, 'pot_1', 'harvest');
    while (!h.ok) {
      await new Promise((r) => setTimeout(r, 200));
      h = await act(a, 'pot_1', 'harvest');
    }
    expect(count(bagOf(room, 'lab-player-0008'), 'plant_fresh_base')).toBe(strain.freshPerPlant);

    // étendre, attendre le séchage, décrocher
    goTo(room, 'lab-player-0008', 'rack_2');
    expect((await act(a, 'rack_2', 'hang')).ok).toBe(true);
    let c = await act(a, 'rack_2', 'collect');
    while (!c.ok) {
      await new Promise((r) => setTimeout(r, 200));
      c = await act(a, 'rack_2', 'collect');
    }
    expect(count(bagOf(room, 'lab-player-0008'), 'plant_dried_base')).toBe(strain.freshPerPlant);

    // découper : les pochons arrivent dans le sac à la fin de la découpe
    goTo(room, 'lab-player-0008', 'table_1');
    expect((await act(a, 'table_1', 'cut')).ok).toBe(true);
    const finished = (await a.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
    expect(finished.text).toMatch(/Pochon/);
    expect(count(bagOf(room, 'lab-player-0008'), 'pouch_base')).toBe(
      strain.freshPerPlant * strain.pouchesPerDried,
    );
  }, 20000);
});

describe('sauvegarde', () => {
  it('restaure une partie depuis son snapshot (même code, mêmes sacs, joueurs hors ligne)', async () => {
    const { client, room } = await newGame('lab-player-0010');
    goTo(room, 'lab-player-0010', 'water');
    const p0 = room.state.players.get('lab-player-0010')!;
    writeInventory(p0.bag, [{ itemId: 'water', qty: 2 }, ...readInventory(p0.bag).slice(1)]);
    equip(room);
    room.state.lab.pots.get(sid('pot_3'))!.planted = true;
    const snap = RoomSnapshotSchema.parse(JSON.parse(JSON.stringify(room.snapshot())));
    expect(snap.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    const code = room.roomId;
    await client.leave();
    await room.disconnect();

    const restored = (await matchMaker.createRoom(ROOM_NAME, { restore: snap })) as {
      roomId: string;
    };
    expect(restored.roomId).toBe(code);
    const again = colyseus.getRoomById<GameState>(code) as ServerRoom<GameState> as NarcoRoom;
    const p = again.state.players.get('lab-player-0010')!;
    expect(p.connected).toBe(false);
    expect(p.zone).toBe('lab');
    expect(count(readInventory(p.bag), 'water')).toBe(2);
    // meubles restaurés à l'identique : ids, objets, positions, rotations, compteur d'ids
    expect(again.state.lab.toJSON().fixtures).toEqual(room.state.lab.toJSON().fixtures);
    expect(again.state.lab.nextFixtureId).toBe(room.state.lab.nextFixtureId);
    expect(again.state.lab.fixtures.size).toBe(11);
    expect(again.state.lab.pots.get(sid('pot_3'))!.planted).toBe(true);

    // le joueur revient avec son playerId et retrouve tout
    await colyseus.sdk.joinById(code, { playerId: 'lab-player-0010', name: 'Chimiste' });
    expect(p.connected).toBe(true);
  });

  it('ignore une sauvegarde d’une ancienne version, avec un log clair', () => {
    const file = joinPath(mkdtempSync(joinPath(tmpdir(), 'narco-')), 'rooms.json');
    const room = (code: string, schemaVersion?: number) => ({
      code,
      ...(schemaVersion === undefined ? {} : { schemaVersion }),
      clock: { now: 0, scale: 1 },
      state: { code, players: {}, lab: {} },
    });
    const rooms = [room('OLD1'), room('OLD2', 2), room('NEW3', SNAPSHOT_SCHEMA_VERSION)];
    writeFileSync(file, JSON.stringify({ version: 1, savedAt: 0, rooms }));
    const logs: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void logs.push(args.join(' '));
    try {
      expect(readSnapshotFile(file).map((r) => r.code)).toEqual(['NEW3']);
    } finally {
      console.warn = warn;
    }
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/OLD1.*v1.*ignorée, partie neuve/);
    expect(logs[1]).toMatch(/OLD2.*v2/);
  });
});
