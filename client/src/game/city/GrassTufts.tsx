import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Euler, Matrix4, Quaternion, Vector3, type InstancedMesh, type Material } from 'three';
import { groundCover, type GameData, type GrassParams } from '@narco/shared';
import { Batch, shade } from './batch';
import { areaIdNear } from '../areaStreaming';
import { shadedMaterial, type Shading } from '../materials';

/** Partagés par le shader : temps (s), amplitude (m), vitesse (rad/s) du vent. */
export const windUniforms = {
  uWindTime: { value: 0 },
  uWindAmp: { value: 0 },
  uWindSpeed: { value: 0 },
};

/**
 * Vent des touffes dans le vertex shader : sommets déplacés en x/z selon leur hauteur et une phase
 * tirée de la position de l'instance (aucun calcul CPU par touffe, une uniform par image).
 */
export function windMaterial(shading: Shading): Material {
  const m = shadedMaterial({ vertexColors: true }, shading);
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, windUniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uWindTime;\nuniform float uWindAmp;\nuniform float uWindSpeed;',
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec2 windAt = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
#else
  vec2 windAt = vec2(0.0);
#endif
  float windPhase = uWindTime * uWindSpeed + windAt.x * 0.37 + windAt.y * 0.23;
  transformed.x += sin(windPhase) * uWindAmp * position.y;
  transformed.z += cos(windPhase * 0.8) * uWindAmp * 0.5 * position.y;`,
      );
  };
  m.customProgramCacheKey = () => `narco-wind-${shading.mode}`;
  return m;
}

const tmpM = new Matrix4();
const tmpQ = new Quaternion();
const tmpE = new Euler();
const tmpP = new Vector3();
const tmpS = new Vector3();

/**
 * Touffes d'herbe du thème jour : 1 InstancedMesh (trois brins en éventail), seulement dans les
 * areas chargées. Vent coupé (`wind` faux, qualité basse) : touffes immobiles, aucune uniform.
 */
export function GrassTufts({
  data,
  grass,
  shading,
  loaded,
  wind,
}: {
  data: GameData;
  grass: GrassParams;
  shading: Shading;
  loaded: ReadonlySet<string> | null;
  wind: boolean;
}) {
  const ref = useRef<InstancedMesh>(null);
  const tufts = useMemo(() => groundCover(data, grass).tufts, [data, grass]);
  const areas = useMemo(() => tufts.map((t) => areaIdNear(t)), [tufts]);
  const { geometry, material } = useMemo(() => {
    const b = new Batch();
    b.cuttable = false;
    for (let k = 0; k < 3; k++)
      b.box(
        0,
        0.22,
        0,
        0.06,
        0.45,
        0.06,
        shade(grass.tuft, 0.9 + k * 0.12),
        (k - 1) * 0.35,
        k * 2.1,
        0,
      );
    return { geometry: b.build(), material: windMaterial(shading) };
  }, [grass, shading]);
  useLayoutEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );
  useLayoutEffect(() => {
    windUniforms.uWindAmp.value = wind ? grass.wind.amplitude : 0;
    windUniforms.uWindSpeed.value = grass.wind.speed;
  }, [wind, grass]);
  useFrame((_, dt) => {
    if (wind) windUniforms.uWindTime.value += dt;
  });
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    let n = 0;
    tufts.forEach((t, i) => {
      if (loaded && !loaded.has(areas[i]!)) return;
      tmpQ.setFromEuler(tmpE.set(0, t.rotY, 0));
      mesh.setMatrixAt(n++, tmpM.compose(tmpP.set(t.x, 0, t.z), tmpQ, tmpS.setScalar(t.scale)));
    });
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [tufts, areas, loaded]);
  if (tufts.length === 0) return null;
  return (
    <instancedMesh
      ref={ref}
      name="touffes"
      args={[geometry, material, tufts.length]}
      frustumCulled={false}
    />
  );
}
