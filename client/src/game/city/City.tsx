import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { MeshBasicMaterial, MeshLambertMaterial, Vector2, Vector3, type Camera } from 'three';
import { gameData } from '@narco/shared';
import { localPlayer } from '../localPlayer';
import { buildCity } from './buildCity';
import { Decor } from './Decor';
import { shade } from './batch';
import { applyCutout, cutoutUniforms, getCutout } from './cutout';

const { palette, world } = gameData.config;
// Teintes de la palette très éclaircies : lumière de nuit bleutée, assez forte pour lire les volumes.
const SKY_LIGHT = shade(palette.wall, 10);
const GROUND_LIGHT = shade(palette.ground, 6);
const MOON = shade(palette.wall, 9);

/** Ambiance de nuit : 2 lumières seulement (hémisphère + lune), brouillard couleur ciel. */
export function NightAmbience() {
  return (
    <>
      <color attach="background" args={[palette.sky]} />
      <fog attach="fog" args={[palette.sky, 35, 95]} />
      {/* Couleurs de lumière = teintes de la palette éclaircies (nuit bleutée, pas de noir pur). */}
      <hemisphereLight args={[SKY_LIGHT, GROUND_LIGHT, 1.1]} />
      <directionalLight position={[-12, 25, 10]} intensity={1.3} color={MOON} />
    </>
  );
}

const playerCenter = new Vector3();
const projected = new Vector3();
const edge = new Vector3();
const right = new Vector3();
const buffer = new Vector2();

/** Pixels (tampon de rendu) entre le centre du joueur et un point à `meters` sur sa droite écran. */
function screenRadius(camera: Camera, meters: number, width: number, height: number): number {
  edge.copy(playerCenter).addScaledVector(right, meters).project(camera);
  return Math.hypot(((edge.x - projected.x) / 2) * width, ((edge.y - projected.y) / 2) * height);
}

/** Met à jour les uniforms de découpe : position du joueur local, projection, rayon en pixels. */
function CutoutDriver() {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  useFrame(() => {
    const cfg = getCutout();
    const u = cutoutUniforms;
    if (!cfg.enabled || !localPlayer.initialized) {
      u.uCutEnabled.value = 0;
      return;
    }
    playerCenter.set(localPlayer.x, world.playerSize / 2, localPlayer.z);
    projected.copy(playerCenter).project(camera);
    gl.getDrawingBufferSize(buffer);
    right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const radiusPx = screenRadius(camera, cfg.radius, buffer.x, buffer.y);
    const innerPx = screenRadius(
      camera,
      Math.max(0, cfg.radius - cfg.softness),
      buffer.x,
      buffer.y,
    );
    u.uCutEnabled.value = projected.z < 1 ? 1 : 0;
    u.uCutPlayer.value.copy(playerCenter);
    u.uCutScreen.value.set(((projected.x + 1) / 2) * buffer.x, ((projected.y + 1) / 2) * buffer.y);
    u.uCutRadiusPx.value = radiusPx;
    u.uCutSoftPx.value = Math.max(1, radiusPx - innerPx);
  });
  return null;
}

/** Le quartier : 2 géométries fusionnées (murs + lumières) + décor instancié. */
export function City({ glowBoost }: { glowBoost: number }) {
  const geometry = useMemo(() => buildCity(gameData), []);
  // Bâtiments : découpe devant le joueur. Décor (bas) : matériaux sans découpe.
  const materials = useMemo(
    () => ({
      solid: applyCutout(new MeshLambertMaterial({ vertexColors: true })),
      glow: applyCutout(new MeshBasicMaterial({ vertexColors: true, toneMapped: false })),
      decorSolid: new MeshLambertMaterial({ vertexColors: true }),
      decorGlow: new MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    }),
    [],
  );

  // En qualité moyen/haut, les émissifs passent au-dessus de 1 pour déclencher le bloom.
  useEffect(() => {
    materials.glow.color.setScalar(glowBoost);
    materials.decorGlow.color.setScalar(glowBoost);
  }, [materials, glowBoost]);

  useEffect(
    () => () => {
      geometry.solid.dispose();
      geometry.glow.dispose();
      for (const m of Object.values(materials)) m.dispose();
    },
    [geometry, materials],
  );

  return (
    <>
      <mesh geometry={geometry.solid} material={materials.solid} />
      <mesh geometry={geometry.glow} material={materials.glow} />
      <Decor
        data={gameData}
        solidMaterial={materials.decorSolid}
        glowMaterial={materials.decorGlow}
      />
      <CutoutDriver />
    </>
  );
}
