import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  Color,
  Euler,
  InstancedBufferAttribute,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type InstancedMesh,
} from 'three';
import type { GameData } from '@narco/shared';
import { areaIdNear } from '../areaStreaming';
import { glowQuadMaterial } from '../glowShaders';
import { haloPlacements } from './haloPlacements';

const m = new Matrix4();
const q = new Quaternion();
const e = new Euler();
const p = new Vector3();
const s = new Vector3();
const c = new Color();

/**
 * Halos des néons : un seul InstancedMesh additif (1 draw call), filtré par areas chargées.
 * Les gyrophares clignotent par uniform (`uTime`) : aucune lumière ajoutée.
 */
export function Halos({
  data,
  loaded,
  glowBoost,
}: {
  data: GameData;
  loaded: ReadonlySet<string> | null;
  glowBoost: number;
}) {
  const ref = useRef<InstancedMesh>(null);
  const halos = useMemo(() => haloPlacements(data), [data]);
  const areas = useMemo(() => halos.map((h) => areaIdNear(h)), [halos]);
  const { geometry, material } = useMemo(() => {
    const geometry = new PlaneGeometry(1, 1);
    return {
      geometry,
      material: glowQuadMaterial({
        color: '#ffffff',
        opacity: data.config.render.halo.opacity,
        inner: 0,
        additive: true,
      }),
    };
  }, [halos, data]);
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );
  useEffect(() => {
    material.uniforms.uBoost!.value = glowBoost;
  }, [material, glowBoost]);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const visible = loaded ? halos.filter((_, i) => loaded.has(areas[i]!)) : halos;
    const blink = new Float32Array(Math.max(1, halos.length) * 2);
    visible.forEach((h, i) => {
      q.setFromEuler(e.set(0, h.ry, 0));
      mesh.setMatrixAt(i, m.compose(p.set(h.x, h.y, h.z), q, s.set(h.size, h.size, 1)));
      mesh.setColorAt(i, c.set(h.color));
      blink[i * 2] = h.blinkHz;
      blink[i * 2 + 1] = h.phase;
    });
    geometry.setAttribute('aBlink', new InstancedBufferAttribute(blink, 2));
    mesh.count = visible.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [halos, areas, loaded, geometry]);

  useFrame(({ clock }) => {
    material.uniforms.uTime!.value = clock.elapsedTime;
  });

  if (halos.length === 0) return null;
  return (
    <instancedMesh
      ref={ref}
      args={[geometry, material, halos.length]}
      frustumCulled={false}
      renderOrder={2}
    />
  );
}
