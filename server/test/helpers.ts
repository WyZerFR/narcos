import { ColyseusTestServer } from '@colyseus/testing';
import { gameData, type Vec2 } from '@narco/shared';
import { createGameServer } from '../src/app';
import { spawnFurniture } from '../src/rooms/furniture';
import type { NarcoRoom } from '../src/rooms/NarcoRoom';

/**
 * Démarre un serveur de test sur un port dédié. `boot()` de @colyseus/testing ignore le port
 * quand on lui passe un `Server` ; or chaque fichier de test tourne en parallèle.
 */
export async function bootOn(port: number): Promise<ColyseusTestServer> {
  const server = createGameServer();
  await server.listen(port);
  return new ColyseusTestServer(server);
}

/**
 * Agencement de test connu (l'ancien labo meublé), posé par la même validation que les
 * joueurs : alias lisible → objet et position.
 */
export const TEST_LAYOUT = {
  pot_1: { itemId: 'pot', x: -5, z: -2.8, rot: 0 },
  pot_2: { itemId: 'pot', x: -2.6, z: -2.8, rot: 0 },
  pot_3: { itemId: 'pot', x: -5, z: -0.4, rot: 0 },
  pot_4: { itemId: 'pot', x: -2.6, z: -0.4, rot: 0 },
  rack_1: { itemId: 'drying_rack', x: 1.4, z: -4, rot: 0 },
  rack_2: { itemId: 'drying_rack', x: 1.4, z: -1.6, rot: 0 },
  table_1: { itemId: 'cutting_table', x: 4.6, z: -0.6, rot: 0 },
  lamp_1: { itemId: 'grow_lamp', x: -6.3, z: -2.8, rot: 0 },
  lamp_2: { itemId: 'grow_lamp', x: -3.8, z: -4.3, rot: 0 },
  lamp_3: { itemId: 'grow_lamp', x: -3.8, z: -1.6, rot: 0 },
  lamp_4: { itemId: 'grow_lamp', x: -1.3, z: -1.6, rot: 0 },
} as const;
export type LayoutName = keyof typeof TEST_LAYOUT;

/** Pose les meubles demandés (tous par défaut) ; renvoie alias → id du meuble. */
export function furnish(
  room: NarcoRoom,
  names: readonly LayoutName[] = Object.keys(TEST_LAYOUT) as LayoutName[],
): Record<string, string> {
  const lab = gameData.interiors.get('lab')!;
  const ids: Record<string, string> = {};
  for (const name of names) {
    const r = spawnFurniture(room.state, lab, TEST_LAYOUT[name], room.now());
    if ('error' in r) throw new Error(`${name} : ${r.error}`);
    ids[name] = r.id;
  }
  return ids;
}

/** Point juste devant (côté +z) un poste fixe ou un meuble de l'agencement de test. */
export function frontOf(name: string, interiorId = 'lab'): Vec2 {
  const layout = (TEST_LAYOUT as Record<string, { itemId: string; x: number; z: number }>)[name];
  if (layout) {
    const p = gameData.items.get(layout.itemId)!.placeable!;
    const d = p.mount === 'ceiling' ? 0 : p.d;
    return { x: layout.x, z: layout.z + d / 2 + 0.5 };
  }
  const st = gameData.interiors.get(interiorId)!.stations.find((s) => s.id === name)!;
  return { x: st.position.x, z: st.position.z + st.size.d / 2 + 0.5 };
}
