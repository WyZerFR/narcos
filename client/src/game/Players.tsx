import { useEffect, useRef, useState, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group } from 'three';
import {
  ClientMsg,
  gameData,
  moveWithCollisions,
  Reconciler,
  appearanceKey,
  resolveAppearance,
  resolveCharacterId,
  SnapshotBuffer,
  speedFactor,
  STREET,
  type Appearance,
  type Collider,
  type MoveMessage,
} from '@narco/shared';
import { FRAME_PRIORITY } from './framePriority';
import { CharacterBody } from './characters/CharacterBody';
import { connection, type GameRoom, type PlayerView } from '../net/connection';
import { readMoveIntent } from '../input/inputState';
import { subscribeState } from '../net/gameView';
import { localPlayer } from './localPlayer';
import { remoteActorPositions } from './blobRegistry';
import { screenToWorld } from './cameraState';
import { isOccluded, setLabelAnchor } from './labels';
import { getCutout } from './city/cutout';
import { areaFor, fixturesFor } from './fixtureState';

const { movement, world } = gameData.config;
const SIZE = world.playerSize;
const SEND_INTERVAL = 1 / movement.clientSendRateHz;
const net = gameData.config.netSmoothing;
const MAX_FRAME_DT = 0.1;

/** Corrections du serveur sur la position prédite (écart mesuré au `seq` concerné). */
const reconciler = new Reconciler({
  ignoreDistance: net.correctionIgnoreDistance,
  snapDistance: net.correctionSnapDistance,
  blendStiffness: net.correctionBlendStiffness,
});

function colliderFor(room: GameRoom): Collider | null {
  const area = areaFor(localPlayer.zone, fixturesFor(room, localPlayer.zone));
  return area
    ? {
        radius: world.playerRadius,
        obstacles: area.obstacles,
        bounds: area.bounds,
        maxSubStep: gameData.config.collision.maxSubStep,
      }
    : null;
}

export interface PlayerInfo {
  id: string;
  name: string;
  color: string;
  connected: boolean;
  /** Zone du joueur (rue ou intérieur) : on ne voit que les joueurs de sa propre zone. */
  zone: string;
  /** Personnage choisi (characters.json), validé par le serveur. */
  characterId: string;
  /** Couleurs par slot (palettes.json), validées par le serveur puis ici. */
  appearance: Appearance;
}

/** Liste des joueurs pour React : ne change que si un joueur arrive/part/change de statut. */
/** Personnage et couleurs d'un joueur synchronisé (revalidés : serveur ancien ou données). */
export function lookOf(p: Pick<PlayerView, 'characterId' | 'appearance'>) {
  const characterId = resolveCharacterId(gameData, p.characterId);
  const raw: Record<string, string> = {};
  p.appearance?.forEach((value, key) => {
    raw[key] = value;
  });
  return { characterId, appearance: resolveAppearance(gameData, characterId, raw) };
}

export function useRoomPlayers(room: GameRoom | null): PlayerInfo[] {
  const [players, setPlayers] = useState<PlayerInfo[]>([]);
  useEffect(() => {
    if (!room) return;
    let signature = '';
    const refresh = () => {
      const list: PlayerInfo[] = [];
      room.state.players?.forEach((p: PlayerView) =>
        list.push({
          id: p.id,
          name: p.name,
          color: p.color,
          connected: p.connected,
          zone: p.zone,
          ...lookOf(p),
        }),
      );
      const next = list
        .map(
          (p) =>
            `${p.id}|${p.name}|${p.color}|${p.connected}|${p.zone}|${p.characterId}|${appearanceKey(p.appearance)}`,
        )
        .join(';');
      if (next !== signature) {
        signature = next;
        setPlayers(list);
      }
    };
    refresh();
    return subscribeState(room, refresh);
  }, [room]);
  return room ? players : [];
}

/**
 * Ancre l'étiquette DOM du joueur au-dessus de son cube, et son marqueur « caché » quand un
 * bâtiment s'interpose. Le joueur local n'en a besoin que si la découpe est désactivée.
 */
function usePlayerLabel(
  id: string,
  ref: RefObject<Group | null>,
  isLocal: boolean,
  characterId: string,
) {
  useEffect(() => {
    // au-dessus de la tête du personnage (ou du cube de repli)
    const y = Math.max(
      SIZE * 1.7,
      (gameData.characters.get(characterId)?.height ?? 0) + gameData.config.characters.labelMargin,
    );
    setLabelAnchor(`player:${id}`, () => {
      const g = ref.current;
      return g ? { x: g.position.x, y, z: g.position.z } : null;
    });
    setLabelAnchor(`marker:${id}`, (camera) => {
      const g = ref.current;
      // Occlusion calculée contre les bâtiments de la rue uniquement.
      if (!g || localPlayer.zone !== STREET || (isLocal && getCutout().enabled)) return null;
      const center = { x: g.position.x, y: SIZE / 2, z: g.position.z };
      return isOccluded(camera, center) ? center : null;
    });
    return () => {
      setLabelAnchor(`player:${id}`, null);
      setLabelAnchor(`marker:${id}`, null);
    };
  }, [id, ref, isLocal, characterId]);
}

export function LocalPlayer({ room, info }: { room: GameRoom; info: PlayerInfo }) {
  const ref = useRef<Group>(null);
  usePlayerLabel(info.id, ref, true, info.characterId);
  const sendTimer = useRef(0);
  const lastSent = useRef({ x: NaN, z: NaN, rotY: NaN });

  useEffect(
    () =>
      connection.onCorrection((c) => {
        const col = colliderFor(room);
        if (!col || !localPlayer.initialized) return;
        const r = reconciler.correct(localPlayer, c, col);
        localPlayer.x = r.pos.x;
        localPlayer.z = r.pos.z;
      }),
    [room],
  );

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, MAX_FRAME_DT);
    const me = room.state.players?.get(info.id);
    if (!me) return;
    // (Re)connexion ou changement de zone : on repart de la position du serveur.
    if (!localPlayer.initialized || localPlayer.zone !== me.zone) {
      Object.assign(localPlayer, {
        initialized: true,
        zone: me.zone,
        x: me.x,
        z: me.z,
        rotY: me.rotY,
      });
      lastSent.current = { x: me.x, z: me.z, rotY: me.rotY };
      reconciler.reset();
    }

    // bornes + obstacles de la zone, mobilier installé compris : même calcul que le serveur
    const area = areaFor(localPlayer.zone, fixturesFor(room, localPlayer.zone));
    const intent = readMoveIntent();
    if (area && intent.magnitude > 0.05 && room.connection.isOpen) {
      // Même ralentissement que le serveur quand la faim ou la soif passe sous le seuil bas.
      const slow = speedFactor(me, gameData.economy.survival);
      const speed =
        slow *
        (intent.run ? movement.runSpeed : movement.walkSpeed * Math.min(1, intent.magnitude / 0.9));
      // Direction relative à la caméra : haut du joystick = haut de l'écran.
      const dir = screenToWorld(intent.x, intent.y);
      // Même fonction que le serveur : la prédiction glisse sur les murs comme la validation.
      const next = moveWithCollisions(
        localPlayer,
        { x: localPlayer.x + dir.x * speed * dt, z: localPlayer.z + dir.z * speed * dt },
        world.playerRadius,
        area.obstacles,
        area.bounds,
        gameData.config.collision.maxSubStep,
      );
      localPlayer.x = next.x;
      localPlayer.z = next.z;
      localPlayer.rotY = Math.atan2(dir.x, dir.z);
    }
    // fondu d'une correction moyenne du serveur, quelques frames, sans traverser de mur
    if (area) {
      const next = reconciler.step(localPlayer, dt, {
        radius: world.playerRadius,
        obstacles: area.obstacles,
        bounds: area.bounds,
        maxSubStep: gameData.config.collision.maxSubStep,
      });
      localPlayer.x = next.x;
      localPlayer.z = next.z;
    }

    sendTimer.current += dt;
    const ls = lastSent.current;
    const changed =
      ls.x !== localPlayer.x || ls.z !== localPlayer.z || ls.rotY !== localPlayer.rotY;
    if (changed && sendTimer.current >= SEND_INTERVAL && room.connection.isOpen) {
      sendTimer.current = 0;
      localPlayer.seq++;
      const msg: MoveMessage = {
        zone: localPlayer.zone,
        x: localPlayer.x,
        z: localPlayer.z,
        rotY: localPlayer.rotY,
        seq: localPlayer.seq,
      };
      room.send(ClientMsg.Move, msg);
      reconciler.recordSent(msg.seq, msg);
      lastSent.current = { x: localPlayer.x, z: localPlayer.z, rotY: localPlayer.rotY };
    }

    const g = ref.current;
    // rotation du corps : lissée par CharacterBody (locomotion), pas par le groupe
    if (g) g.position.set(localPlayer.x, 0, localPlayer.z);
  }, FRAME_PRIORITY.actors);

  return (
    <group ref={ref}>
      <CharacterBody
        characterId={info.characterId}
        appearance={info.appearance}
        color={info.color}
        ghost={false}
        heading={() => localPlayer.rotY}
      />
    </group>
  );
}

export function RemotePlayer({ room, info }: { room: GameRoom; info: PlayerInfo }) {
  const ref = useRef<Group>(null);
  usePlayerLabel(info.id, ref, false, info.characterId);
  // Instantanés reçus, affichés avec un léger retard fixe (interpolation, jamais de saut).
  const buffer = useRef(new SnapshotBuffer(gameData.config.room.patchRateMs));
  const last = useRef({ x: NaN, z: NaN, rotY: NaN });
  const heading = useRef(room.state.players?.get(info.id)?.rotY ?? 0);
  useEffect(() => () => void remoteActorPositions.delete(info.id), [info.id]);

  useFrame(() => {
    const p = room.state.players?.get(info.id);
    const g = ref.current;
    if (!p || !g) return;
    const now = performance.now();
    const l = last.current;
    if (p.x !== l.x || p.z !== l.z || p.rotY !== l.rotY) {
      buffer.current.push({ t: now, x: p.x, z: p.z, rotY: p.rotY });
      last.current = { x: p.x, z: p.z, rotY: p.rotY };
    }
    const s = buffer.current.sample(now - net.remoteDelayMs);
    if (!s) return;
    // position interpolée : la locomotion en déduit la vitesse (pas des positions reçues)
    g.position.set(s.x, 0, s.z);
    remoteActorPositions.set(info.id, { x: s.x, z: s.z });
    heading.current = s.rotY;
  }, FRAME_PRIORITY.actors);

  return (
    <group ref={ref}>
      <CharacterBody
        characterId={info.characterId}
        appearance={info.appearance}
        color={info.color}
        ghost={!info.connected}
        heading={() => heading.current}
      />
    </group>
  );
}
