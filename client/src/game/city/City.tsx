import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { MeshBasicMaterial, MeshLambertMaterial, Vector2, Vector3, type Camera } from 'three';
import { gameData } from '@narco/shared';
import { localPlayer } from '../localPlayer';
import { buildCity } from './buildCity';
import { SEA_GROUP } from './areaBatches';
import { useLoadedAreas } from '../areaStreaming';
import { Decor } from './Decor';
import { shade } from './batch';
import { applyCutout, cutoutUniforms, getCutout } from './cutout';

const { palette, world } = gameData.config;
// Teintes de la palette très éclaircies : lumière de nuit bleutée, assez forte pour lire les volumes.
const SKY_LIGHT = shade(palette.wall, 10);
const GROUND_LIGHT = shade(palette.ground, 6);
const MOON = shade(palette.wall, 9);
/** Fond derrière les murs d'un intérieur : le ciel, très assombri. */
const INTERIOR_VOID = shade(palette.sky, 0.4);

/** Ambiance de nuit : 2 lumières seulement (hémisphère + lune) ; brouillard dans la rue seulement. */
export function NightAmbience({ interior = false }: { interior?: boolean }) {
  return (
    <>
      <color attach="background" args={[interior ? INTERIOR_VOID : palette.sky]} />
      {!interior && <fog attach="fog" args={[palette.sky, 35, 95]} />}
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

/** Images rendues avec toute l'île visible au montage : géométries envoyées au GPU d'avance. */
const WARMUP_FRAMES = 2;

/**
 * L'île : 2 géométries fusionnées (murs + lumières) par area, seules l'area du joueur et ses
 * voisines directes sont dessinées (la mer toujours) ; décor instancié filtré de même.
 * `lockVersion` : reconstruction quand le verrou d'une area change (portail de l'aéroport).
 */
export function City({ glowBoost, lockVersion }: { glowBoost: number; lockVersion: number }) {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- lockVersion : gameData muté en place
  const geometry = useMemo(() => buildCity(gameData), [lockVersion]);
  const loaded = useLoadedAreas();
  const [warm, setWarm] = useState(false);
  const frames = useRef(0);
  useFrame(() => {
    if (!warm && ++frames.current > WARMUP_FRAMES) setWarm(true);
  });
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
      for (const g of geometry.values()) {
        g.solid?.dispose();
        g.glow?.dispose();
      }
    },
    [geometry],
  );
  useEffect(
    () => () => {
      for (const m of Object.values(materials)) m.dispose();
    },
    [materials],
  );

  return (
    <>
      {[...geometry].map(([key, g]) => {
        const visible = !warm || key === SEA_GROUP || loaded.has(key);
        return (
          <group key={key} visible={visible}>
            {g.solid && <mesh geometry={g.solid} material={materials.solid} />}
            {g.glow && <mesh geometry={g.glow} material={materials.glow} />}
          </group>
        );
      })}
      <Decor
        loaded={warm ? loaded : null}
        data={gameData}
        solidMaterial={materials.decorSolid}
        glowMaterial={materials.decorGlow}
      />
      <CutoutDriver />
    </>
  );
}
