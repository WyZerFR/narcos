import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
  BoxGeometry,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
  type InstancedMesh,
} from 'three';
import { gameData, type Interior } from '@narco/shared';
import type { GameRoom } from '../../net/connection';
import { subscribeState } from '../../net/gameView';
import { installedSet } from '../fixtureState';
import { emptyParts, installedParts, maxParts, type PartBox } from './fixtureParts';

const m = new Matrix4();
const q = new Quaternion();
const p = new Vector3();
const s = new Vector3();

/**
 * Mobilier installé du labo (pots, étendoirs, table, lampes) et repères des emplacements
 * vides : 2 draw calls au total (cubes unitaires instanciés, opaques + lumineux), mis à jour
 * seulement quand la liste des emplacements installés change. Jamais percés par la découpe.
 */
export function FixtureProps({
  room,
  interior,
  glowBoost,
}: {
  room: GameRoom;
  interior: Interior;
  glowBoost: number;
}) {
  const neon = gameData.locations.get(interior.entranceLocationId)!.neonColor;
  const capacity = useMemo(() => maxParts(interior.fixtures, neon), [interior, neon]);
  const solidRef = useRef<InstancedMesh>(null);
  const glowRef = useRef<InstancedMesh>(null);

  const { geometry, solidMat, glowMat } = useMemo(
    () => ({
      geometry: new BoxGeometry(1, 1, 1),
      solidMat: new MeshLambertMaterial(),
      glowMat: new MeshBasicMaterial({ toneMapped: false }),
    }),
    [],
  );

  useEffect(() => {
    glowMat.color.setScalar(glowBoost);
  }, [glowMat, glowBoost]);

  useLayoutEffect(
    () => () => {
      geometry.dispose();
      solidMat.dispose();
      glowMat.dispose();
    },
    [geometry, solidMat, glowMat],
  );

  useEffect(() => {
    let signature: string | null = null;
    const write = (mesh: InstancedMesh | null, parts: PartBox[]) => {
      if (!mesh) return;
      parts.forEach((b, i) => {
        m.compose(p.set(b.x, b.y, b.z), q, s.set(b.sx, b.sy, b.sz));
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, b.color);
      });
      mesh.count = parts.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    };
    const refresh = () => {
      const installed = installedSet(room);
      const next = [...installed].sort().join(',');
      if (next === signature) return;
      signature = next;
      const solid: PartBox[] = [];
      const glow: PartBox[] = [];
      for (const f of interior.fixtures) {
        const parts = installed.has(f.id) ? installedParts(f, neon) : emptyParts(f);
        solid.push(...parts.solid);
        glow.push(...parts.glow);
      }
      write(solidRef.current, solid);
      write(glowRef.current, glow);
    };
    refresh();
    return subscribeState(room, refresh);
  }, [room, interior, neon]);

  return (
    <>
      <instancedMesh
        ref={solidRef}
        args={[geometry, solidMat, capacity.solid]}
        frustumCulled={false}
      />
      <instancedMesh
        ref={glowRef}
        args={[geometry, glowMat, capacity.glow]}
        frustumCulled={false}
      />
    </>
  );
}
