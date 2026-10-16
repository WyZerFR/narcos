import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useFrame } from '@react-three/fiber';
import { Matrix4, PlaneGeometry, Quaternion, Vector3, type InstancedMesh } from 'three';
import { gameData, STREET } from '@narco/shared';
import type { GameRoom, NpcView, PlayerView } from '../net/connection';
import { connection } from '../net/connection';
import { localPlayer } from './localPlayer';
import { npcSmoothed } from './npcState';
import { areaIdNear, useLoadedAreas } from './areaStreaming';
import { FRAME_PRIORITY } from './framePriority';
import { glowQuadMaterial } from './glowShaders';
import { getStaticBlobs, onStaticBlobs, remoteActorPositions, type Blob } from './blobRegistry';
import { shade } from './city/batch';

const { config } = gameData;
const { blob } = config.render;
/** Emplacements réservés aux acteurs (joueurs puis PNJ), réécrits à chaque frame. */
const ACTOR_SLOTS = config.room.maxPlayers + config.npc.maxTotal;
/** Juste au-dessus des trottoirs (0,14 m) : visible partout, sans scintillement. */
const Y = 0.16;

const m = new Matrix4();
const q = new Quaternion();
const p = new Vector3();
const s = new Vector3();

function write(mesh: InstancedMesh, i: number, b: Blob | null) {
  if (b) m.compose(p.set(b.x, Y, b.z), q, s.set(b.r, 1, b.r));
  else m.compose(p.set(0, -100, 0), q, s.set(0, 0, 0));
  mesh.setMatrixAt(i, m);
}

/**
 * Ombres blob : un seul InstancedMesh (1 draw call) sous les joueurs, les PNJ, les voitures et
 * les props du décor. Aucune lumière, aucune carte d'ombre : un disque sombre en dégradé.
 */
export function BlobShadows({ room, zone }: { room: GameRoom; zone: string }) {
  const ref = useRef<InstancedMesh>(null);
  const statics = useSyncExternalStore(onStaticBlobs, getStaticBlobs);
  const loaded = useLoadedAreas();
  const street = zone === STREET;
  const { geometry, material } = useMemo(
    () => ({
      geometry: new PlaneGeometry(2, 2).rotateX(-Math.PI / 2),
      material: glowQuadMaterial({
        color: shade(config.palette.sky, 0.25),
        opacity: blob.opacity,
        inner: 0.25,
        additive: false,
      }),
    }),
    [],
  );
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );
  const staticAreas = useMemo(() => statics.list.map((b) => areaIdNear(b)), [statics]);
  const capacity = ACTOR_SLOTS + statics.list.length;

  // Ombres fixes : écrites quand les areas chargées changent, après les emplacements des acteurs.
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const visible = street ? statics.list.filter((_, i) => loaded.has(staticAreas[i]!)) : [];
    visible.forEach((b, i) => write(mesh, ACTOR_SLOTS + i, b));
    mesh.count = ACTOR_SLOTS + visible.length;
    mesh.instanceMatrix.needsUpdate = true;
  }, [statics, staticAreas, loaded, street, capacity]);

  useFrame(() => {
    const mesh = ref.current;
    if (!mesh) return;
    let i = 0;
    room.state.players?.forEach((pl: PlayerView) => {
      if (i >= config.room.maxPlayers || pl.zone !== zone) return;
      const me = pl.id === connection.playerId;
      const pos = me && localPlayer.initialized ? localPlayer : remoteActorPositions.get(pl.id);
      if (pos) write(mesh, i++, { x: pos.x, z: pos.z, r: blob.radius.player });
    });
    if (street)
      room.state.npcs?.forEach((n: NpcView) => {
        const pos = npcSmoothed.get(n.id);
        if (pos && i < ACTOR_SLOTS) write(mesh, i++, { x: pos.x, z: pos.z, r: blob.radius.npc });
      });
    for (let j = i; j < ACTOR_SLOTS; j++) write(mesh, j, null);
    mesh.instanceMatrix.needsUpdate = true;
  }, FRAME_PRIORITY.camera);

  return (
    <instancedMesh
      key={capacity}
      ref={ref}
      args={[geometry, material, capacity]}
      frustumCulled={false}
      renderOrder={-1}
    />
  );
}
