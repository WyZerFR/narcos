import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room as ServerRoom } from '@colyseus/core';
import { ClientMsg, gameData, ROOM_NAME, type CharacterChooseMessage } from '@narco/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NarcoRoom } from '../src/rooms/NarcoRoom';
import { GameState } from '../src/rooms/schema';
import { readInventory } from '../src/rooms/stateSync';
import { hydrateState, RoomSnapshotSchema, SNAPSHOT_SCHEMA_VERSION } from '../src/persistence';
import { bootOn } from './helpers';

const DEFAULT = gameData.config.characters.defaultId;
let colyseus: ColyseusTestServer;

beforeAll(async () => {
  colyseus = await bootOn(2584);
});
afterAll(async () => {
  await colyseus.shutdown();
});
beforeEach(async () => {
  await colyseus.cleanup();
});

/** Attend qu'une condition devienne vraie (état synchronisé côté client). */
async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('délai dépassé');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('sélection de personnage', () => {
  it('défaut à la création, choix diffusé aux autres joueurs, sans toucher au sac', async () => {
    const a = await colyseus.sdk.create<GameState>(ROOM_NAME, {
      playerId: 'chr-player-000a',
      name: 'A',
    });
    const room = colyseus.getRoomById<GameState>(a.roomId) as ServerRoom<GameState> as NarcoRoom;
    const b = await colyseus.sdk.joinById<GameState>(a.roomId, {
      playerId: 'chr-player-000b',
      name: 'B',
    });
    const pa = room.state.players.get('chr-player-000a')!;
    expect(pa.characterId).toBe(DEFAULT);
    const bagBefore = JSON.stringify(readInventory(pa.bag));
    const cleanBefore = pa.cleanBalance;

    const msg: CharacterChooseMessage = { characterId: 'perso_2' };
    a.send(ClientMsg.CharacterChoose, msg);
    await until(() => b.state.players?.get('chr-player-000a')?.characterId === 'perso_2');
    expect(room.state.players.get('chr-player-000a')!.characterId).toBe('perso_2');
    // l'autre joueur n'est pas touché ; sac et compte intacts
    expect(b.state.players!.get('chr-player-000b')!.characterId).toBe(DEFAULT);
    expect(JSON.stringify(readInventory(pa.bag))).toBe(bagBefore);
    expect(pa.cleanBalance).toBe(cleanBefore);
    await b.leave();
  });

  it('perso_2 de bout en bout : état du client, serveur, snapshot puis reprise', async () => {
    const a = await colyseus.sdk.create<GameState>(ROOM_NAME, {
      playerId: 'chr-player-000d',
      name: 'D',
    });
    const room = colyseus.getRoomById<GameState>(a.roomId) as ServerRoom<GameState> as NarcoRoom;
    await until(() => a.state.players?.get('chr-player-000d')?.characterId === DEFAULT);
    a.send(ClientMsg.CharacterChoose, { characterId: 'perso_2' } satisfies CharacterChooseMessage);
    // le client voit son propre choix (l'écran de sélection et le rendu lisent cet état)
    await until(() => a.state.players?.get('chr-player-000d')?.characterId === 'perso_2');
    expect(room.state.players.get('chr-player-000d')!.characterId).toBe('perso_2');
    const snap = RoomSnapshotSchema.parse(JSON.parse(JSON.stringify(room.snapshot())));
    const restored = new GameState();
    hydrateState(restored, snap);
    expect(restored.players.get('chr-player-000d')!.characterId).toBe('perso_2');
  });

  it('id inconnu : remplacé par le défaut', async () => {
    const a = await colyseus.sdk.create<GameState>(ROOM_NAME, {
      playerId: 'chr-player-000c',
      name: 'C',
    });
    const room = colyseus.getRoomById<GameState>(a.roomId) as ServerRoom<GameState> as NarcoRoom;
    a.send(ClientMsg.CharacterChoose, { characterId: 'perso_2' });
    await until(() => room.state.players.get('chr-player-000c')!.characterId === 'perso_2');
    a.send(ClientMsg.CharacterChoose, { characterId: 'dark_vador' });
    await until(() => room.state.players.get('chr-player-000c')!.characterId === DEFAULT);
    a.send(ClientMsg.CharacterChoose, { characterId: 42 });
    await new Promise((r) => setTimeout(r, 50));
    expect(room.state.players.get('chr-player-000c')!.characterId).toBe(DEFAULT);
  });
});

describe('personnage — sauvegarde', () => {
  const snapOf = (player: Record<string, unknown>) =>
    RoomSnapshotSchema.parse({
      code: 'ABCD',
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      savedAt: 0,
      clock: { now: 0, scale: 1 },
      state: {
        ...new GameState().toJSON(),
        code: 'ABCD',
        players: { [String(player.id)]: player },
      },
    });
  const base = { id: 'old', name: 'Ancien', color: '#ffffff', x: 0, z: 0 };

  it('ancien snapshot sans characterId : chargé avec le défaut ; choix et id inconnu', () => {
    const state = new GameState();
    hydrateState(state, snapOf(base));
    expect(state.players.get('old')!.characterId).toBe(DEFAULT);
    hydrateState(state, snapOf({ ...base, id: 'p2', characterId: 'perso_2' }));
    expect(state.players.get('p2')!.characterId).toBe('perso_2');
    hydrateState(state, snapOf({ ...base, id: 'gone', characterId: 'perso_supprime' }));
    expect(state.players.get('gone')!.characterId).toBe(DEFAULT);
  });

  it('le snapshot écrit contient le personnage', () => {
    const state = new GameState();
    hydrateState(state, snapOf({ ...base, characterId: 'perso_2' }));
    const json = state.toJSON() as { players: Record<string, { characterId?: string }> };
    expect(json.players.old!.characterId).toBe('perso_2');
  });
});
