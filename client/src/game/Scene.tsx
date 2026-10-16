import { useEffect, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import {
  OrthographicCamera as OrthographicCameraImpl,
  PerspectiveCamera as PerspectiveCameraImpl,
  Vector3,
} from 'three';
import {
  fitInteriorZoom,
  gameData,
  realShadowsEnabled,
  type ThemeId,
  interiorCameraTarget,
  smoothFactor,
  STREET,
} from '@narco/shared';
import { FRAME_PRIORITY } from './framePriority';
import { connection, type GameRoom } from '../net/connection';
import { QUALITY_PRESETS, useSettings } from '../ui/settings';
import { debugStats } from '../ui/DebugOverlay';
import { localPlayer, resetLocalPlayer } from './localPlayer';
import { City } from './city/City';
import { Ambience } from './Ambience';
import { BlobShadows } from './BlobShadows';
import { useAreaLocks } from './areaLocks';
import { AreaBounds } from './AreaBounds';
import { LabelProjector } from './labels';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import { cameraOffset, getCamera, orthoViewHeight, setCameraKind, useCamera } from './cameraState';
import { Interior } from './interior/Interior';
import { LocalPlayer, RemotePlayer, useRoomPlayers } from './Players';
import { Npcs } from './Npcs';
import { getPlacement } from '../ui/placementStore';

const { cameraRig, interiorFraming } = gameData.config;
const placementCamera = gameData.config.placement.camera;

/** Caméra 3/4 vue de dessus : suit le joueur local, réglages lus à chaque frame (live). */
function CameraRig() {
  const { type, fov } = useCamera();
  const camera = useThree((s) => s.camera);
  const height = useThree((s) => s.size.height);
  const width = useThree((s) => s.size.width);
  const target = useRef(new Vector3());
  const zone = useRef('');

  useFrame((_, dt) => {
    if (!localPlayer.initialized) return;
    // Changement de zone : jeu de réglages adapté et caméra recalée d'un coup (pas de travelling).
    if (zone.current !== localPlayer.zone) {
      zone.current = localPlayer.zone;
      setCameraKind(localPlayer.zone === STREET ? 'street' : 'interior');
      target.current.set(localPlayer.x, 0, localPlayer.z);
    }
    // Mode placement : vue haute (config.placement.camera) centrée sur le fantôme.
    // (glisser direct d'un meuble : la caméra ne bouge pas sous le doigt)
    const pl = getPlacement();
    const placing = pl && !pl.direct ? pl : null;
    const interior = gameData.interiors.get(localPlayer.zone);
    let c = placing ? { ...getCamera(), ...placementCamera } : getCamera();
    let follow: { x: number; z: number } = placing ?? localPlayer;
    // Intérieur : la pièce entière reste lisible, quelle que soit sa taille (layoutScale).
    if (interior && !placing) {
      const fit = fitInteriorZoom(interior, c, width / height, interiorFraming);
      if (fit > c.zoom) c = { ...c, zoom: fit };
      follow = interiorCameraTarget(localPlayer, interiorFraming);
    }
    const t = smoothFactor(cameraRig.followStiffness, Math.min(dt, 0.1));
    target.current.x += (follow.x - target.current.x) * t;
    target.current.z += (follow.z - target.current.z) * t;
    const o = cameraOffset(c);
    camera.position.set(target.current.x + o.x, o.y, target.current.z + o.z);
    camera.lookAt(target.current);

    if (camera instanceof PerspectiveCameraImpl && camera.fov !== c.fov) {
      camera.fov = c.fov;
      camera.updateProjectionMatrix();
    } else if (camera instanceof OrthographicCameraImpl) {
      const zoom = height / orthoViewHeight(c);
      if (camera.zoom !== zoom) {
        camera.zoom = zoom;
        camera.updateProjectionMatrix();
      }
    }
    // matrices à jour tout de suite : les étiquettes DOM sont projetées dans cette même frame
    camera.updateMatrixWorld();
  }, FRAME_PRIORITY.camera);

  return type === 'ortho' ? (
    <OrthographicCamera makeDefault near={cameraRig.near} far={cameraRig.far} />
  ) : (
    <PerspectiveCamera makeDefault fov={fov} near={cameraRig.near} far={cameraRig.far} />
  );
}

/** Alimente l'overlay debug (FPS, draw calls, triangles) sans rendu React. */
function DebugProbe() {
  const { gl, scene, camera, advance } = useThree();
  const acc = useRef({ frames: 0, time: 0 });
  // Accès console en mode debug : `narco.three.gl.info`, rendu manuel, etc.
  useEffect(() => {
    if (window.narco) {
      window.narco.three = { gl, scene, camera };
      window.narco.local = localPlayer;
      window.narco.advance = () => advance(performance.now());
    }
    gl.info.autoReset = false;
    return () => {
      gl.info.autoReset = true;
    };
  }, [gl, scene, camera, advance]);
  useFrame((_, dt) => {
    acc.current.frames++;
    acc.current.time += dt;
    if (acc.current.time >= 0.5) {
      debugStats.fps = acc.current.frames / acc.current.time;
      acc.current = { frames: 0, time: 0 };
    }
    // Compteurs cumulés sur toute la frame précédente (passes de bloom comprises), puis remis à 0.
    debugStats.calls = gl.info.render.calls;
    debugStats.triangles = gl.info.render.triangles;
    gl.info.reset();
  });
  return null;
}

function World({
  room,
  glowBoost,
  themeId,
  shadows,
}: {
  room: GameRoom;
  glowBoost: number;
  themeId: ThemeId;
  shadows: boolean;
}) {
  const players = useRoomPlayers(room);
  const myId = connection.playerId;
  const myZone = players.find((p) => p.id === myId)?.zone ?? STREET;
  const inStreet = myZone === STREET;
  const lockVersion = useAreaLocks(room);
  // Nouvelle room (connexion ou reconnexion) : on repart de la position autoritaire du serveur.
  useEffect(() => resetLocalPlayer(), [room]);
  return (
    <>
      <Ambience themeId={themeId} interior={!inStreet} shadows={shadows} />
      {/* La ville reste montée (pas de reconstruction) mais n'est pas dessinée à l'intérieur. */}
      <group visible={inStreet}>
        <City glowBoost={glowBoost} lockVersion={lockVersion} themeId={themeId} shadows={shadows} />
        <AreaBounds />
      </group>
      {inStreet && <Npcs room={room} />}
      <BlobShadows room={room} zone={myZone} />
      {!inStreet && gameData.interiors.has(myZone) && (
        <Interior key={myZone} room={room} zoneId={myZone} glowBoost={glowBoost} />
      )}
      {players
        .filter((p) => p.zone === myZone)
        .map((p) =>
          p.id === myId ? (
            <LocalPlayer key={p.id} room={room} info={p} />
          ) : (
            <RemotePlayer key={p.id} room={room} info={p} />
          ),
        )}
      <CameraRig />
      <LabelProjector />
    </>
  );
}

/** Écran tactile (iPad, téléphone) : jamais d'ombre temps réel si config.render l'interdit. */
function isTouchDevice(): boolean {
  return navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;
}

export function Scene({ room }: { room: GameRoom }) {
  const { quality, theme, debug } = useSettings();
  const preset = QUALITY_PRESETS[quality];
  const shadows = realShadowsEnabled(gameData.config, quality, isTouchDevice());
  return (
    <Canvas
      key={quality /* l'antialias et les ombres ne se changent qu'en recréant le contexte */}
      className="scene"
      dpr={Math.min(preset.dpr, window.devicePixelRatio || 1)}
      gl={{ antialias: preset.antialias, powerPreference: 'high-performance' }}
      shadows={shadows}
    >
      <World room={room} glowBoost={preset.glowBoost} themeId={theme} shadows={shadows} />
      {preset.bloom > 0 && (
        <EffectComposer multisampling={0}>
          <Bloom
            mipmapBlur
            luminanceThreshold={1}
            luminanceSmoothing={0.2}
            intensity={preset.bloom}
          />
        </EffectComposer>
      )}
      {debug && <DebugProbe />}
    </Canvas>
  );
}
