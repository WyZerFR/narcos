import { useEffect, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Vector3 } from 'three';
import { connection, type GameRoom } from '../net/connection';
import { QUALITY_PRESETS, useSettings } from '../ui/settings';
import { debugStats } from '../ui/DebugOverlay';
import { localPlayer, resetLocalPlayer } from './localPlayer';
import { Floor } from './Floor';
import { LocalPlayer, RemotePlayer, useRoomPlayers } from './Players';

/** Caméra 3/4 vue de dessus (offset technique, pas de l'équilibrage). */
const CAMERA_OFFSET = new Vector3(0, 16, 12);
const CAMERA_FOLLOW = 6;

function CameraRig() {
  const camera = useThree((s) => s.camera);
  const target = useRef(new Vector3());
  useFrame((_, dt) => {
    if (!localPlayer.initialized) return;
    const t = 1 - Math.exp(-CAMERA_FOLLOW * Math.min(dt, 0.1));
    target.current.x += (localPlayer.x - target.current.x) * t;
    target.current.z += (localPlayer.z - target.current.z) * t;
    camera.position.copy(target.current).add(CAMERA_OFFSET);
    camera.lookAt(target.current);
  });
  return null;
}

/** Alimente l'overlay debug (FPS, draw calls, triangles) sans rendu React. */
function DebugProbe() {
  const gl = useThree((s) => s.gl);
  const acc = useRef({ frames: 0, time: 0 });
  useFrame((_, dt) => {
    acc.current.frames++;
    acc.current.time += dt;
    if (acc.current.time >= 0.5) {
      debugStats.fps = acc.current.frames / acc.current.time;
      acc.current = { frames: 0, time: 0 };
    }
    debugStats.calls = gl.info.render.calls;
    debugStats.triangles = gl.info.render.triangles;
  });
  return null;
}

function World({ room }: { room: GameRoom }) {
  const players = useRoomPlayers(room);
  const myId = connection.playerId;
  // Nouvelle room (connexion ou reconnexion) : on repart de la position autoritaire du serveur.
  useEffect(() => resetLocalPlayer(), [room]);
  return (
    <>
      <color attach="background" args={['#1c1a17']} />
      <ambientLight intensity={1.1} />
      <directionalLight position={[10, 20, 8]} intensity={1.6} />
      <Floor />
      {players.map((p) =>
        p.id === myId ? (
          <LocalPlayer key={p.id} room={room} info={p} />
        ) : (
          <RemotePlayer key={p.id} room={room} info={p} />
        ),
      )}
      <CameraRig />
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
      camera={{ fov: 50, near: 0.5, far: 200, position: [0, 16, 12] }}
    >
      <World room={room} />
      {debug && <DebugProbe />}
    </Canvas>
  );
}
