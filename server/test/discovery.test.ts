import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room as ServerRoom } from '@colyseus/core';
import {
  AREA_PREFIX,
  ClientMsg,
  PLACE_PREFIX,
  ROOM_NAME,
  ServerMsg,
  gameData,
  type NoticeMessage,
} from '@narco/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NarcoRoom } from '../src/rooms/NarcoRoom';
import { GameState } from '../src/rooms/schema';
import { hydrateState, RoomSnapshotSchema, SNAPSHOT_SCHEMA_VERSION } from '../src/persistence';
import { bootOn } from './helpers';

let colyseus: ColyseusTestServer;

beforeAll(async () => {
  colyseus = await bootOn(2587);
});
afterAll(async () => {
  await colyseus.shutdown();
});
beforeEach(async () => {
  await colyseus.cleanup();
});

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('délai dépassé');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const HIDDEN = [...gameData.locations.values()].filter((l) => l.hidden);

/** Découvertes d'un joueur telles que décodées par un client (vide si non reçues). */
function seenBy(state: GameState, playerId: string): string[] {
  const p = state.players.get(playerId) as { discovered?: Iterable<string> } | undefined;
  return p?.discovered ? [...p.discovered] : [];
}

describe('brouillard de guerre — serveur', () => {
  it('départ découvert, découverte par joueur, diffusée à lui seul', async () => {
    const a = await colyseus.sdk.create<GameState>(ROOM_NAME, {
      playerId: 'fog-a-0001',
      name: 'A',
    });
    const room = colyseus.getRoomById<GameState>(a.roomId);
    const b = await colyseus.sdk.joinById<GameState>(a.roomId, {
      playerId: 'fog-b-0001',
      name: 'B',
    });
    const pa = room.state.players.get('fog-a-0001')!;
    const pb = room.state.players.get('fog-b-0001')!;
    expect([...pa.discovered]).toContain(AREA_PREFIX + 'bas_fonds');
    expect([...pa.discovered]).not.toContain(AREA_PREFIX + 'cartel');

    a.send(ClientMsg.Debug, { cmd: 'teleport', areaId: 'cartel' });
    expect(((await a.waitForMessage(ServerMsg.Notice)) as NoticeMessage).ok).toBe(true);
    expect([...pa.discovered]).toContain(AREA_PREFIX + 'cartel');
    expect([...pa.discovered]).toContain(PLACE_PREFIX + 'repaire_jefe');
    // B n'a rien découvert de plus
    expect([...pb.discovered]).not.toContain(AREA_PREFIX + 'cartel');

    // côté clients : chacun reçoit ses découvertes, jamais celles de l'autre
    await until(() => seenBy(a.state, 'fog-a-0001').includes(AREA_PREFIX + 'cartel'));
    await until(() => seenBy(b.state, 'fog-b-0001').includes(AREA_PREFIX + 'bas_fonds'));
    expect(seenBy(a.state, 'fog-b-0001')).toEqual([]);
    expect(seenBy(b.state, 'fog-a-0001')).toEqual([]);
  });

  it('debug : tout révéler sans jamais la trappe, puis tout masquer', async () => {
    const c = await colyseus.sdk.create<GameState>(ROOM_NAME, {
      playerId: 'fog-c-0001',
      name: 'C',
    });
    const room = colyseus.getRoomById<GameState>(c.roomId);
    const p = room.state.players.get('fog-c-0001')!;
    c.send(ClientMsg.Debug, { cmd: 'discovery', mode: 'all' });
    await c.waitForMessage(ServerMsg.Notice);
    expect(p.discovered.length).toBeGreaterThan(gameData.areas.size);
    for (const loc of HIDDEN)
      expect([...p.discovered].some((id) => id.includes(loc.id))).toBe(false);
    c.send(ClientMsg.Debug, { cmd: 'discovery', mode: 'none' });
    await c.waitForMessage(ServerMsg.Notice);
    expect(p.discovered.length).toBe(0);
  });

  it('sauvegarde : découvertes conservées ; ancienne sauvegarde : départ seul', async () => {
    const d = await colyseus.sdk.create<GameState>(ROOM_NAME, {
      playerId: 'fog-d-0001',
      name: 'D',
    });
    const room = colyseus.getRoomById<GameState>(d.roomId) as unknown as ServerRoom & NarcoRoom;
    d.send(ClientMsg.Debug, { cmd: 'teleport', areaId: 'cartel' });
    await d.waitForMessage(ServerMsg.Notice);
    const restored = new GameState();
    hydrateState(restored, RoomSnapshotSchema.parse(JSON.parse(JSON.stringify(room.snapshot()))));
    expect([...restored.players.get('fog-d-0001')!.discovered]).toContain(AREA_PREFIX + 'cartel');

    // ancienne sauvegarde (sans champ) : area de départ seule, même ailleurs sur l'île
    const repaire = gameData.locations.get('repaire_jefe')!.position;
    const old = RoomSnapshotSchema.parse({
      code: 'FOGS',
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      savedAt: 0,
      clock: { now: 0, scale: 1 },
      state: {
        ...new GameState().toJSON(),
        code: 'FOGS',
        players: {
          old: { id: 'old', name: 'Ancien', color: '#ffffff', x: repaire.x, z: repaire.z + 9 },
        },
      },
    });
    const state = new GameState();
    hydrateState(state, old);
    expect([...state.players.get('old')!.discovered]).toEqual([AREA_PREFIX + 'bas_fonds']);
  });
});
