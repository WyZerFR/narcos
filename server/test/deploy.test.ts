import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ColyseusTestServer } from '@colyseus/testing';
import { Client } from 'colyseus.js';
import { ClientMsg, gameData, ROOM_NAME, ServerMsg, type NoticeMessage } from '@narco/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGameServer } from '../src/app';
import { snapshotFile, writeSnapshotFile } from '../src/persistence';
import type { GameState } from '../src/rooms/schema';

const PORT = 2579;
const BASE = `http://localhost:${PORT}`;
const STATIC = mkdtempSync(join(tmpdir(), 'narco-static-'));
mkdirSync(join(STATIC, 'assets'));
writeFileSync(join(STATIC, 'index.html'), '<!doctype html><title>narco</title>');
writeFileSync(join(STATIC, 'sw.js'), '// sw');
writeFileSync(join(STATIC, 'assets', 'app-123.js'), 'console.log(1)');

let colyseus: ColyseusTestServer;
const savedEnv = { ...process.env };
let nextPlayer = 1;
const playerId = () => `deploy-player-${String(nextPlayer++).padStart(4, '0')}`;

beforeAll(async () => {
  const server = createGameServer(STATIC);
  await server.listen(PORT);
  colyseus = new ColyseusTestServer(server);
});
afterAll(async () => {
  await colyseus.shutdown();
});
beforeEach(async () => {
  await colyseus.cleanup();
});
afterEach(() => {
  process.env = { ...savedEnv };
});

describe('déploiement — HTTP sur le même port', () => {
  it('/health répond 200, aussi sous /colyseus ; /info dit si un code est demandé', async () => {
    for (const path of ['/health', '/colyseus/health']) {
      const res = await fetch(BASE + path);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    }
    expect(await (await fetch(`${BASE}/colyseus/info`)).json()).toEqual({ accessRequired: false });
    process.env.NARCO_ACCESS_CODE = 'tacos';
    expect(await (await fetch(`${BASE}/info`)).json()).toEqual({ accessRequired: true });
  });

  it('sert le client compilé : index, routes de l’app, assets en cache long, pas de sortie du dossier', async () => {
    const index = await fetch(`${BASE}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('cache-control')).toBe('no-cache');
    expect(await index.text()).toContain('narco');
    expect((await fetch(`${BASE}/partie/ABCD`)).status).toBe(200);
    expect((await fetch(`${BASE}/sw.js`)).headers.get('cache-control')).toBe('no-cache');
    const asset = await fetch(`${BASE}/assets/app-123.js`);
    expect(asset.headers.get('cache-control')).toMatch(/immutable/);
    expect((await fetch(`${BASE}/manque.js`)).status).toBe(404);
    expect((await fetch(`${BASE}/..%2F..%2Fpackage.json`)).status).toBe(404);
  });

  it('WebSocket et matchmaking passent par /colyseus sur le même port', async () => {
    const client = new Client(`ws://localhost:${PORT}/colyseus`);
    const room = await client.create<GameState>(ROOM_NAME, { playerId: playerId(), name: 'Web' });
    expect(room.roomId).toHaveLength(gameData.config.room.codeLength);
    await room.leave();
  });
});

describe('déploiement — accès et limites', () => {
  it('avec NARCO_ACCESS_CODE : refus sans code ou avec un mauvais code, accepté avec le bon', async () => {
    process.env.NARCO_ACCESS_CODE = 'tacos';
    await expect(
      colyseus.sdk.create(ROOM_NAME, { playerId: playerId(), name: 'Intrus' }),
    ).rejects.toThrow(/Code d'accès incorrect/);
    await expect(
      colyseus.sdk.create(ROOM_NAME, { playerId: playerId(), name: 'Intrus', accessCode: 'nope' }),
    ).rejects.toThrow(/Code d'accès incorrect/);
    const host = await colyseus.sdk.create(ROOM_NAME, {
      playerId: playerId(),
      name: 'Hôte',
      accessCode: 'tacos',
    });
    await expect(
      colyseus.sdk.joinById(host.roomId, { playerId: playerId(), name: 'Intrus' }),
    ).rejects.toThrow(/Code d'accès incorrect/);
    const friend = await colyseus.sdk.joinById(host.roomId, {
      playerId: playerId(),
      name: 'Pote',
      accessCode: ' tacos ',
    });
    expect(friend.roomId).toBe(host.roomId);
  });

  it(`limite de parties simultanées (config.room.maxRooms)`, async () => {
    const max = gameData.config.room.maxRooms;
    for (let i = 0; i < max; i++)
      await colyseus.sdk.create(ROOM_NAME, { playerId: playerId(), name: `J${i}` });
    await expect(
      colyseus.sdk.create(ROOM_NAME, { playerId: playerId(), name: 'De trop' }),
    ).rejects.toThrow(/Trop de parties/);
  });

  it('commandes debug coupées en production, sauf NARCO_DEBUG=1', async () => {
    const client = await colyseus.sdk.create(ROOM_NAME, { playerId: playerId(), name: 'Prod' });
    const debug = async () => {
      client.send(ClientMsg.Debug, { cmd: 'restock' });
      return (await client.waitForMessage(ServerMsg.Notice)) as NoticeMessage;
    };
    process.env.NODE_ENV = 'production';
    expect(await debug()).toMatchObject({ ok: false, text: 'Commandes debug désactivées.' });
    process.env.NARCO_DEBUG = '1';
    expect((await debug()).ok).toBe(true);
  });
});

describe('déploiement — données', () => {
  it('NARCO_DATA_DIR choisit le dossier des sauvegardes, créé s’il manque', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'narco-data-')), 'volume', 'data');
    process.env.NARCO_DATA_DIR = dir;
    expect(snapshotFile()).toBe(join(dir, 'rooms.json'));
    writeSnapshotFile(snapshotFile(), []);
    expect(existsSync(join(dir, 'rooms.json'))).toBe(true);
  });
});
