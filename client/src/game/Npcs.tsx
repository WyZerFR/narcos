import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  BoxGeometry,
  Color,
  Euler,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
  type InstancedMesh,
} from 'three';
import { gameData } from '@narco/shared';
import type { GameRoom, NpcView } from '../net/connection';
import { npcSmoothed, useNpcList } from './npcState';
import { shade } from './city/batch';
import { isOccluded, setLabelAnchor } from './labels';

const { npc: NPC, palette } = gameData.config;
const PROFILES = new Map(gameData.npcs.profiles.map((p) => [p.id, p]));
/** Raideur du lissage (1/s) : positions reçues à `broadcastHz`, mouvement continu à l'écran. */
const SMOOTHING = 6;
const BODY = { w: 0.6, h: 1.1, d: 0.4 };
const HEAD = 0.42;
const MAX_FRAME_DT = 0.1;

const m = new Matrix4();
const q = new Quaternion();
const e = new Euler();
const p = new Vector3();
const s = new Vector3();
const off = new Vector3();

/**
 * PNJ de la rue : 2 `InstancedMesh` (corps, tête) pour toute la population, quel que soit leur
 * nombre. Couleur du corps selon le profil (palette × facteur). Bulle 💬 en DOM s'il achète.
 */
export function Npcs({ room }: { room: GameRoom }) {
  const bodyRef = useRef<InstancedMesh>(null);
  const headRef = useRef<InstancedMesh>(null);
  const capacity = NPC.count;

  const { bodyGeo, headGeo, material } = useMemo(
    () => ({
      bodyGeo: new BoxGeometry(BODY.w, BODY.h, BODY.d).translate(0, BODY.h / 2, 0),
      headGeo: new BoxGeometry(HEAD, HEAD, HEAD).translate(0, BODY.h + HEAD / 2 + 0.02, 0),
      material: new MeshLambertMaterial(),
    }),
    [],
  );
  useLayoutEffect(
    () => () => {
      bodyGeo.dispose();
      headGeo.dispose();
      material.dispose();
    },
    [bodyGeo, headGeo, material],
  );

  // Ancres des bulles : au-dessus de la tête, masquées derrière un bâtiment.
  const list = useNpcList(room);
  useEffect(() => {
    for (const n of list)
      setLabelAnchor(`npc:${n.id}`, (camera) => {
        const pos = npcSmoothed.get(n.id);
        if (!pos) return null;
        const top = { x: pos.x, y: BODY.h + HEAD + 0.5, z: pos.z };
        return isOccluded(camera, top) ? null : top;
      });
    return () => {
      for (const n of list) setLabelAnchor(`npc:${n.id}`, null);
    };
  }, [list]);

  useFrame((_, rawDt) => {
    const body = bodyRef.current;
    const head = headRef.current;
    if (!body || !head) return;
    const t = 1 - Math.exp(-SMOOTHING * Math.min(rawDt, MAX_FRAME_DT));
    let i = 0;
    room.state.npcs?.forEach((n: NpcView) => {
      if (i >= capacity) return;
      let cur = npcSmoothed.get(n.id);
      if (!cur) {
        cur = { x: n.x, z: n.z, rotY: n.rotY };
        npcSmoothed.set(n.id, cur);
      }
      cur.x += (n.x - cur.x) * t;
      cur.z += (n.z - cur.z) * t;
      const d = Math.atan2(Math.sin(n.rotY - cur.rotY), Math.cos(n.rotY - cur.rotY));
      cur.rotY += d * t;
      q.setFromEuler(e.set(0, cur.rotY, 0));
      m.compose(p.set(cur.x, 0, cur.z), q, s.set(1, 1, 1));
      body.setMatrixAt(i, m);
      head.setMatrixAt(i, m);
      const profile = PROFILES.get(n.profileId);
      body.setColorAt(
        i,
        profile ? shade(palette[profile.color], profile.shade) : new Color(1, 1, 1),
      );
      head.setColorAt(i, shade(palette.ground, 2.4));
      i++;
    });
    // instances inutilisées : écrasées à l'échelle 0
    for (let j = i; j < capacity; j++) {
      m.compose(off.set(0, -100, 0), q.identity(), s.set(0, 0, 0));
      body.setMatrixAt(j, m);
      head.setMatrixAt(j, m);
    }
    body.instanceMatrix.needsUpdate = true;
    head.instanceMatrix.needsUpdate = true;
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
    if (head.instanceColor) head.instanceColor.needsUpdate = true;
  });

  return (
    <>
      <instancedMesh ref={bodyRef} args={[bodyGeo, material, capacity]} frustumCulled={false} />
      <instancedMesh ref={headRef} args={[headGeo, material, capacity]} frustumCulled={false} />
    </>
  );
}
