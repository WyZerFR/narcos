import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room as ServerRoom } from '@colyseus/core';
import {
  ClientMsg,
  gameData,
  ROOM_NAME,
  type AppearanceSetMessage,
  type CharacterChooseMessage,
} from '@narco/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NarcoRoom } from '../src/rooms/NarcoRoom';
import { GameState } from '../src/rooms/schema';
import { readInventory } from '../src/rooms/stateSync';
import { hydrateState, RoomSnapshotSchema, SNAPSHOT_SCHEMA_VERSION } from '../src/persistence';
import { bootOn } from './helpers';

let colyseus: ColyseusTestServer;

beforeAll(async () => {
  colyseus = await bootOn(2585);
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

type Look = { forEach(cb: (v: string, k: string) => void): void } | undefined;
const plain = (map: Look): Record<string, string> => {
  const out: Record<string, string> = {};
  map?.forEach((v, k) => {
    out[k] = v;
  });
  return out;
};

describe('apparence', () => {
  it('diffusée entre 2 clients, même modèle et couleurs différentes, sac et compte intacts', async () => {
    const a = await colyseus.sdk.create<GameState>(ROOM_NAME, {
      playerId: 'app-player-00a',
      name: 'A',
    });
    const room = colyseus.getRoomById<GameState>(a.roomId) as ServerRoom<GameState> as NarcoRoom;
    const b = await colyseus.sdk.joinById<GameState>(a.roomId, {
      playerId: 'app-player-00b',
      name: 'B',
    });
    const pa = room.state.players.get('app-player-00a')!;
    const bagBefore = JSON.stringify(readInventory(pa.bag));
    const cleanBefore = pa.cleanBalance;
    for (const c of [a, b])
      c.send(ClientMsg.CharacterChoose, {
        characterId: 'decontractee',
      } satisfies CharacterChooseMessage);
    a.send(ClientMsg.AppearanceSet, {
      appearance: { skin: 'peau_2', top: 'tissu_7' },
    } satisfies AppearanceSetMessage);
    b.send(ClientMsg.AppearanceSet, {
      appearance: { skin: 'peau_9', top: 'tissu_4' },
    } satisfies AppearanceSetMessage);
    const seen = (c: typeof a, id: string) => plain(c.state.players?.get(id)?.appearance as Look);
    await until(
      () =>
        seen(b, 'app-player-00a').top === 'tissu_7' && seen(a, 'app-player-00b').top === 'tissu_4',
    );
    expect(seen(b, 'app-player-00a')).toEqual({ skin: 'peau_2', top: 'tissu_7' });
    expect(seen(a, 'app-player-00b')).toEqual({ skin: 'peau_9', top: 'tissu_4' });
    expect(b.state.players!.get('app-player-00a')!.characterId).toBe('decontractee');
    expect(b.state.players!.get('app-player-00b')!.characterId).toBe('decontractee');
    expect(JSON.stringify(readInventory(pa.bag))).toBe(bagBefore);
    expect(pa.cleanBalance).toBe(cleanBefore);
    await b.leave();
  });

  it('teinte inconnue refusée ; changer de modèle garde les slots encore valides', async () => {
    const a = await colyseus.sdk.create<GameState>(ROOM_NAME, {
      playerId: 'app-player-00c',
      name: 'C',
    });
    const room = colyseus.getRoomById<GameState>(a.roomId) as ServerRoom<GameState> as NarcoRoom;
    const p = () => plain(room.state.players.get('app-player-00c')!.appearance as Look);
    a.send(ClientMsg.CharacterChoose, { characterId: 'decontractee' });
    a.send(ClientMsg.AppearanceSet, {
      appearance: { skin: 'peau_1', hair: '#ff00ff', bottom: 'tissu_2' },
    });
    await until(() => p().skin === 'peau_1');
    expect(p()).toEqual({ skin: 'peau_1', bottom: 'tissu_2' });
    // mannequin : peau seulement
    a.send(ClientMsg.CharacterChoose, { characterId: 'mannequin' });
    await until(() => room.state.players.get('app-player-00c')!.characterId === 'mannequin');
    expect(p()).toEqual({ skin: 'peau_1' });
    a.send(ClientMsg.AppearanceSet, { appearance: 'rouge' });
    await until(() => Object.keys(p()).length === 0);
  });

  it('snapshot : apparence sauvegardée, snapshot ancien sans appearance chargé', async () => {
    const a = await colyseus.sdk.create<GameState>(ROOM_NAME, {
      playerId: 'app-player-00d',
      name: 'D',
    });
    const room = colyseus.getRoomById<GameState>(a.roomId) as ServerRoom<GameState> as NarcoRoom;
    a.send(ClientMsg.AppearanceSet, { appearance: { hair: 'cheveux_8' } });
    await until(
      () => room.state.players.get('app-player-00d')!.appearance.get('hair') === 'cheveux_8',
    );
    const restored = new GameState();
    hydrateState(restored, RoomSnapshotSchema.parse(JSON.parse(JSON.stringify(room.snapshot()))));
    expect(plain(restored.players.get('app-player-00d')!.appearance as Look)).toEqual({
      hair: 'cheveux_8',
    });

    const old = RoomSnapshotSchema.parse({
      code: 'ABCD',
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      savedAt: 0,
      clock: { now: 0, scale: 1 },
      state: {
        ...new GameState().toJSON(),
        code: 'ABCD',
        players: {
          old: {
            id: 'old',
            name: 'Ancien',
            color: '#ffffff',
            x: 0,
            z: 0,
            characterId: 'decontractee',
          },
        },
      },
    });
    const state = new GameState();
    hydrateState(state, old);
    expect(state.players.get('old')!.characterId).toBe('decontractee');
    expect(state.players.get('old')!.appearance.size).toBe(0);
    expect(gameData.characters.get('decontractee')!.slots.skin).toBeDefined();
  });

  it('migration : skin du pack 2 retiré → défaut, couleurs compatibles gardées', () => {
    const DEFAULT = gameData.config.characters.defaultId;
    expect(gameData.characters.has('perso_2')).toBe(false);
    const snap = RoomSnapshotSchema.parse({
      code: 'ABCD',
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      savedAt: 0,
      clock: { now: 0, scale: 1 },
      state: {
        ...new GameState().toJSON(),
        code: 'ABCD',
        players: {
          p2: {
            id: 'p2',
            name: 'Capuche',
            color: '#ffffff',
            x: 0,
            z: 0,
            characterId: 'perso_2',
            // le défaut (Suit_Male) a peau, cheveux, haut ; pas de chaussures
            appearance: { skin: 'peau_4', top: 'tissu_6', shoes: 'tissu_1' },
          },
        },
      },
    });
    const state = new GameState();
    hydrateState(state, snap);
    const p = state.players.get('p2')!;
    expect(p.characterId).toBe(DEFAULT);
    expect(plain(p.appearance as Look)).toEqual({ skin: 'peau_4', top: 'tissu_6' });
  });
});
