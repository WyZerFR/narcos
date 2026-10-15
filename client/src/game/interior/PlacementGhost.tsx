import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  BoxGeometry,
  Color,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
  type InstancedMesh,
  type Mesh,
} from 'three';
import { gameData, rotatedSize, type Interior } from '@narco/shared';
import type { GameRoom } from '../../net/connection';
import {
  checkCurrent,
  getPlacement,
  liftOf,
  livePosition,
  type Placement,
} from '../../ui/placementStore';
import { partsFor } from './fixtureParts';

const { palette } = gameData.config;
/** Revalidation du fantôme (les autres joueurs bougent) : 8 fois par seconde suffit. */
const CHECK_MS = 125;
/** Boîtes max d'un seul meuble (dimensionne l'instanciation du fantôme). */
const MAX_BOXES = 24;

const m = new Matrix4();
const q = new Quaternion();
const p = new Vector3();
const s = new Vector3();
const OK = new Color(palette.ok);
const DANGER = new Color(palette.danger);

/**
 * Fantôme du meuble en cours de placement : forme réelle du meuble (boîtes instanciées,
 * translucides) + empreinte au sol, vert si la position est valide, rouge sinon.
 * 2 draw calls, seulement pendant le placement.
 */
export function PlacementGhost({ room, interior }: { room: GameRoom; interior: Interior }) {
  const boxesRef = useRef<InstancedMesh>(null);
  const floorRef = useRef<Mesh>(null);
  const last = useRef<{ placement: Placement | null; key: string; at: number }>({
    placement: null,
    key: '',
    at: 0,
  });
  const neon = gameData.locations.get(interior.entranceLocationId)!.neonColor;

  const { geometry, boxMat, floorMat } = useMemo(
    () => ({
      geometry: new BoxGeometry(1, 1, 1),
      boxMat: new MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false }),
      floorMat: new MeshBasicMaterial({ transparent: true, opacity: 0.35, depthWrite: false }),
    }),
    [],
  );
  useLayoutEffect(
    () => () => {
      geometry.dispose();
      boxMat.dispose();
      floorMat.dispose();
    },
    [geometry, boxMat, floorMat],
  );

  useFrame(() => {
    const boxes = boxesRef.current;
    const floor = floorRef.current;
    if (!boxes || !floor) return;
    const pl = getPlacement();
    boxes.visible = floor.visible = pl !== null;
    if (!pl) return;
    const now = performance.now();
    const pos = livePosition(pl, now);
    const lift = liftOf(pl);
    const key = `${pos.x},${pos.z},${pl.rot},${lift}`;
    const moved = pl !== last.current.placement || key !== last.current.key;
    if (!moved && now - last.current.at < CHECK_MS) return;
    last.current = { placement: pl, key, at: now };

    // En glisser, couleur mise à jour en direct avec la même règle que le serveur.
    const valid = checkCurrent(room, { ...pl, x: pos.x, z: pos.z })?.ok ?? false;
    const color = valid ? OK : DANGER;
    boxMat.color.copy(color);
    floorMat.color.copy(color);
    if (!moved) return;
    const parts = partsFor(pl.itemId, pos.x, pos.z, pl.rot, neon);
    const all = [...parts.solid, ...parts.glow].slice(0, MAX_BOXES);
    all.forEach((b, i) => {
      m.compose(p.set(b.x, b.y + lift, b.z), q, s.set(b.sx, b.sy, b.sz));
      boxes.setMatrixAt(i, m);
    });
    boxes.count = all.length;
    boxes.instanceMatrix.needsUpdate = true;
    const def = gameData.items.get(pl.itemId)?.placeable;
    if (def) {
      const size = rotatedSize(def, pl.rot);
      floor.position.set(pos.x, 0.02, pos.z);
      floor.scale.set(size.w, 0.02, size.d);
    }
  });

  return (
    <>
      <instancedMesh
        ref={boxesRef}
        args={[geometry, boxMat, MAX_BOXES]}
        frustumCulled={false}
        renderOrder={2}
      />
      <mesh ref={floorRef} geometry={geometry} material={floorMat} renderOrder={2} />
    </>
  );
}
