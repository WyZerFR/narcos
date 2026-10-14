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
import { labFixtures } from '../fixtureState';
import { installedParts, maxParts, type PartBox } from './fixtureParts';

const m = new Matrix4();
const q = new Quaternion();
const p = new Vector3();
const s = new Vector3();

/**
 * Meubles posés du labo (pots, étendoirs, tables, lampes), à leur position et rotation réelles :
 * 2 draw calls au total (cubes unitaires instanciés, opaques + lumineux), quel que soit le
 * nombre de meubles, mis à jour seulement quand un meuble est posé, déplacé ou repris.
 * Jamais percés par la découpe.
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
  const capacity = useMemo(() => maxParts(neon), [neon]);
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
    let last: unknown = null;
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
      const fixtures = labFixtures(room); // même tableau tant que rien ne bouge
      if (fixtures === last) return;
      last = fixtures;
      const solid: PartBox[] = [];
      const glow: PartBox[] = [];
      for (const f of fixtures) {
        const parts = installedParts(f, neon);
        solid.push(...parts.solid.slice(0, capacity.solid - solid.length));
        glow.push(...parts.glow.slice(0, capacity.glow - glow.length));
      }
      write(solidRef.current, solid);
      write(glowRef.current, glow);
    };
    refresh();
    return subscribeState(room, refresh);
  }, [room, neon, capacity]);

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
