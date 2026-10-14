import { useEffect, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import {
  OrthographicCamera as OrthographicCameraImpl,
  PerspectiveCamera as PerspectiveCameraImpl,
  Vector3,
} from 'three';
import { gameData, STREET } from '@narco/shared';
import { connection, type GameRoom } from '../net/connection';
import { QUALITY_PRESETS, useSettings } from '../ui/settings';
import { debugStats } from '../ui/DebugOverlay';
import { localPlayer, resetLocalPlayer } from './localPlayer';
import { City, NightAmbience } from './city/City';
import { LabelProjector } from './labels';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import { cameraOffset, getCamera, orthoViewHeight, setCameraKind, useCamera } from './cameraState';
import { Interior } from './interior/Interior';
import { LocalPlayer, RemotePlayer, useRoomPlayers } from './Players';

const { cameraRig } = gameData.config;

/** Caméra 3/4 vue de dessus : suit le joueur local, réglages lus à chaque frame (live). */
function CameraRig() {
  const { type, fov } = useCamera();
  const camera = useThree((s) => s.camera);
  const height = useThree((s) => s.size.height);
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
    const c = getCamera();
    const t = 1 - Math.exp(-cameraRig.followStiffness * Math.min(dt, 0.1));
    target.current.x += (localPlayer.x - target.current.x) * t;
    target.current.z += (localPlayer.z - target.current.z) * t;
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
  });

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

function World({ room, glowBoost }: { room: GameRoom; glowBoost: number }) {
  const players = useRoomPlayers(room);
  const myId = connection.playerId;
  const myZone = players.find((p) => p.id === myId)?.zone ?? STREET;
  const inStreet = myZone === STREET;
  // Nouvelle room (connexion ou reconnexion) : on repart de la position autoritaire du serveur.
  useEffect(() => resetLocalPlayer(), [room]);
  return (
    <>
      <NightAmbience interior={!inStreet} />
      {/* La ville reste montée (pas de reconstruction) mais n'est pas dessinée à l'intérieur. */}
      <group visible={inStreet}>
        <City glowBoost={glowBoost} />
      </group>
      {!inStreet && gameData.interiors.has(myZone) && (
        <Interior key={myZone} zoneId={myZone} glowBoost={glowBoost} />
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

export function Scene({ room }: { room: GameRoom }) {
  const { quality, debug } = useSettings();
  const preset = QUALITY_PRESETS[quality];
  return (
    <Canvas
      key={quality /* l'antialias ne se change qu'en recréant le contexte WebGL */}
      className="scene"
      dpr={Math.min(preset.dpr, window.devicePixelRatio || 1)}
      gl={{ antialias: preset.antialias, powerPreference: 'high-performance' }}
      shadows={false}
    >
      <World room={room} glowBoost={preset.glowBoost} />
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
