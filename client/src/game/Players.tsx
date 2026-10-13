import { useEffect, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import type { Group } from 'three';
import { ClientMsg, clampToBounds, gameData, type MoveMessage } from '@narco/shared';
import { connection, type GameRoom, type PlayerView } from '../net/connection';
import { readMoveIntent } from '../input/inputState';
import { localPlayer } from './localPlayer';

const { movement, world } = gameData.config;
const SIZE = world.playerSize;
const SEND_INTERVAL = 1 / movement.clientSendRateHz;
/** Raideur du lissage des joueurs distants (1/s). */
const REMOTE_SMOOTHING = 12;
const MAX_FRAME_DT = 0.1;

export interface PlayerInfo {
  id: string;
  name: string;
  color: string;
  connected: boolean;
}

/** Liste des joueurs pour React : ne change que si un joueur arrive/part/change de statut. */
export function useRoomPlayers(room: GameRoom | null): PlayerInfo[] {
  const [players, setPlayers] = useState<PlayerInfo[]>([]);
  useEffect(() => {
    if (!room) return;
    let signature = '';
    const refresh = () => {
      const list: PlayerInfo[] = [];
      room.state.players?.forEach((p: PlayerView) =>
        list.push({ id: p.id, name: p.name, color: p.color, connected: p.connected }),
      );
      const next = list.map((p) => `${p.id}|${p.name}|${p.color}|${p.connected}`).join(';');
      if (next !== signature) {
        signature = next;
        setPlayers(list);
      }
    };
    refresh();
    const sub = room.onStateChange(refresh);
    return () => sub.clear();
  }, [room]);
  return room ? players : [];
}

function Label({ name, offline }: { name: string; offline: boolean }) {
  return (
    <Html
      position={[0, SIZE * 1.6, 0]}
      center
      zIndexRange={[10, 0]}
      style={{ pointerEvents: 'none' }}
    >
      <div className={`player-label${offline ? ' offline' : ''}`}>
        {offline ? `${name} 💤` : name}
      </div>
    </Html>
  );
}

function Body({ color, ghost }: { color: string; ghost: boolean }) {
  return (
    <>
      <mesh position={[0, SIZE / 2, 0]}>
        <boxGeometry args={[SIZE, SIZE, SIZE]} />
        <meshLambertMaterial color={color} transparent={ghost} opacity={ghost ? 0.35 : 1} />
      </mesh>
      {/* « nez » : indique la direction du regard */}
      <mesh position={[0, SIZE * 0.7, SIZE * 0.55]}>
        <boxGeometry args={[SIZE * 0.3, SIZE * 0.2, SIZE * 0.2]} />
        <meshLambertMaterial color="#111111" />
      </mesh>
    </>
  );
}

export function LocalPlayer({ room, info }: { room: GameRoom; info: PlayerInfo }) {
  const ref = useRef<Group>(null);
  const sendTimer = useRef(0);
  const lastSent = useRef({ x: NaN, z: NaN, rotY: NaN });

  useEffect(
    () =>
      connection.onCorrection((c) => {
        localPlayer.x = c.x;
        localPlayer.z = c.z;
      }),
    [],
  );

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, MAX_FRAME_DT);
    const me = room.state.players?.get(info.id);
    if (!me) return;
    if (!localPlayer.initialized) {
      Object.assign(localPlayer, { initialized: true, x: me.x, z: me.z, rotY: me.rotY });
      lastSent.current = { x: me.x, z: me.z, rotY: me.rotY };
    }

    const intent = readMoveIntent();
    if (intent.magnitude > 0.05 && room.connection.isOpen) {
      const speed = intent.run
        ? movement.runSpeed
        : movement.walkSpeed * Math.min(1, intent.magnitude / 0.9);
      // Caméra regardant vers -Z : haut de l'écran = -Z, droite = +X.
      const next = clampToBounds(
        { x: localPlayer.x + intent.x * speed * dt, z: localPlayer.z - intent.y * speed * dt },
        world.bounds,
      );
      localPlayer.x = next.x;
      localPlayer.z = next.z;
      localPlayer.rotY = Math.atan2(intent.x, -intent.y);
    }

    sendTimer.current += dt;
    const ls = lastSent.current;
    const changed =
      ls.x !== localPlayer.x || ls.z !== localPlayer.z || ls.rotY !== localPlayer.rotY;
    if (changed && sendTimer.current >= SEND_INTERVAL && room.connection.isOpen) {
      sendTimer.current = 0;
      localPlayer.seq++;
      const msg: MoveMessage = {
        x: localPlayer.x,
        z: localPlayer.z,
        rotY: localPlayer.rotY,
        seq: localPlayer.seq,
      };
      room.send(ClientMsg.Move, msg);
      lastSent.current = { x: localPlayer.x, z: localPlayer.z, rotY: localPlayer.rotY };
    }

    const g = ref.current;
    if (g) {
      g.position.set(localPlayer.x, 0, localPlayer.z);
      g.rotation.y = localPlayer.rotY;
    }
  });

  return (
    <group ref={ref}>
      <Body color={info.color} ghost={false} />
      <Label name={`${info.name} (toi)`} offline={false} />
    </group>
  );
}

function lerpAngle(a: number, b: number, t: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * t;
}

export function RemotePlayer({ room, info }: { room: GameRoom; info: PlayerInfo }) {
  const ref = useRef<Group>(null);
  const placed = useRef(false);

  useFrame((_, rawDt) => {
    const p = room.state.players?.get(info.id);
    const g = ref.current;
    if (!p || !g) return;
    if (!placed.current) {
      g.position.set(p.x, 0, p.z);
      g.rotation.y = p.rotY;
      placed.current = true;
      return;
    }
    const t = 1 - Math.exp(-REMOTE_SMOOTHING * Math.min(rawDt, MAX_FRAME_DT));
    g.position.x += (p.x - g.position.x) * t;
    g.position.z += (p.z - g.position.z) * t;
    g.rotation.y = lerpAngle(g.rotation.y, p.rotY, t);
  });

  return (
    <group ref={ref}>
      <Body color={info.color} ghost={!info.connected} />
      <Label name={info.name} offline={!info.connected} />
    </group>
  );
}
