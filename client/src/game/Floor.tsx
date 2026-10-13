import { useLayoutEffect, useMemo, useRef } from 'react';
import { Object3D, type InstancedMesh } from 'three';
import { gameData } from '@narco/shared';

const { bounds } = gameData.config.world;
const width = bounds.maxX - bounds.minX;
const depth = bounds.maxZ - bounds.minZ;
const centerX = (bounds.minX + bounds.maxX) / 2;
const centerZ = (bounds.minZ + bounds.maxZ) / 2;

const CRATE_SPACING = 3;

/** Positions de caisses le long des bords de la carte (décor répété → un seul InstancedMesh). */
function crateRing(): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (let x = bounds.minX; x <= bounds.maxX; x += CRATE_SPACING) {
    out.push({ x, z: bounds.minZ - 1 }, { x, z: bounds.maxZ + 1 });
  }
  for (let z = bounds.minZ + CRATE_SPACING; z < bounds.maxZ; z += CRATE_SPACING) {
    out.push({ x: bounds.minX - 1, z }, { x: bounds.maxX + 1, z });
  }
  return out;
}

export function Floor() {
  const crates = useMemo(crateRing, []);
  const meshRef = useRef<InstancedMesh>(null);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const dummy = new Object3D();
    crates.forEach((c, i) => {
      dummy.position.set(c.x, 0.6, c.z);
      dummy.rotation.y = (i * 0.37) % 0.5;
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [crates]);

  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[centerX, 0, centerZ]}>
        <planeGeometry args={[width + 6, depth + 6]} />
        <meshLambertMaterial color="#3b3a36" />
      </mesh>
      <gridHelper
        args={[Math.max(width, depth), Math.max(width, depth) / 5, '#55534d', '#47453f']}
        position={[centerX, 0.01, centerZ]}
      />
      <instancedMesh ref={meshRef} args={[undefined, undefined, crates.length]}>
        <boxGeometry args={[1.2, 1.2, 1.2]} />
        <meshLambertMaterial color="#8a6a3f" />
      </instancedMesh>
    </group>
  );
}
