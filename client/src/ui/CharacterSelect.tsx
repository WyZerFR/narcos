import { useEffect, useMemo, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { AnimationMixer, type Group } from 'three';
import {
  ClientMsg,
  gameData,
  resolveCharacterId,
  type CharacterChooseMessage,
} from '@narco/shared';
import type { GameRoom } from '../net/connection';
import { subscribeState } from '../net/gameView';
import { connection } from '../net/connection';
import {
  instantiate,
  useCharacterAsset,
  type CharacterAsset,
} from '../game/characters/characterAssets';
import { closeCharacterSelect } from './characterSelectStore';

const CHARACTERS = [...gameData.characters.values()];
const { previewSpinSpeed, preview: PREVIEW } = gameData.config.characters;

/** Personnage du joueur local, suivi dans l'état du serveur. */
function useMyCharacter(room: GameRoom): string {
  const [id, setId] = useState(() => resolveCharacterId(gameData, undefined));
  useEffect(
    () =>
      subscribeState(room, () => {
        const me = room.state.players?.get(connection.playerId);
        setId(resolveCharacterId(gameData, me?.characterId));
      }),
    [room],
  );
  return id;
}

/** Un aperçu qui tourne lentement, centré sur la colonne `index` (sur `count`). */
function Preview({ asset, index, count }: { asset: CharacterAsset; index: number; count: number }) {
  const root = useMemo(() => instantiate(asset), [asset]);
  const mixer = useMemo(() => {
    const m = new AnimationMixer(root);
    const idle = asset.clips.find((c) => c.name === asset.character.animations.idle);
    if (idle) m.clipAction(idle).play();
    return m;
  }, [asset, root]);
  const { size } = useThree();
  // centre de la colonne en coordonnées monde (plan z = 0)
  const halfWidth =
    PREVIEW.distance * Math.tan((PREVIEW.fov * Math.PI) / 360) * (size.width / size.height);
  const x = (((index + 0.5) / count) * 2 - 1) * halfWidth;
  useEffect(() => () => void mixer.stopAllAction(), [mixer]);
  useFrame((_, dt) => {
    mixer.update(Math.min(dt, 0.1));
    root.rotation.y += previewSpinSpeed * Math.min(dt, 0.1);
  });
  return <primitive object={root as Group} position={[x, 0, 0]} />;
}

function Previews() {
  return (
    <>
      <hemisphereLight args={[gameData.config.palette.sky, gameData.config.palette.ground, 2.2]} />
      <directionalLight position={[2, 5, 4]} intensity={1.6} />
      {CHARACTERS.map((c, i) => (
        <LoadedPreview key={c.id} id={c.id} index={i} />
      ))}
    </>
  );
}

function LoadedPreview({ id, index }: { id: string; index: number }) {
  const asset = useCharacterAsset(id);
  return typeof asset === 'object' ? (
    <Preview asset={asset} index={index} count={CHARACTERS.length} />
  ) : null;
}

function Card({ id, selected, onChoose }: { id: string; selected: boolean; onChoose: () => void }) {
  const asset = useCharacterAsset(id);
  const character = gameData.characters.get(id)!;
  return (
    <div className={`character-card${selected ? ' selected' : ''}`}>
      <div className="character-stage">
        {asset === 'loading' && <span className="character-status">Chargement…</span>}
        {asset === 'error' && <span className="character-status">Modèle indisponible</span>}
      </div>
      <div className="character-name">{character.name}</div>
      <button type="button" className="btn primary" onClick={onChoose}>
        {selected ? 'Choisi ✓' : 'Choisir'}
      </button>
    </div>
  );
}

/**
 * Sélection du personnage : cartes côte à côte, aperçus 3D sur un seul canvas léger (la scène
 * du jeu n'est pas montée pendant ce temps : un seul contexte WebGL sur iPad).
 */
export function CharacterSelect({ room, code }: { room: GameRoom; code: string | null }) {
  const current = useMyCharacter(room);
  const choose = (characterId: string) => {
    const msg: CharacterChooseMessage = { characterId };
    if (room.connection.isOpen) room.send(ClientMsg.CharacterChoose, msg);
    closeCharacterSelect(code ?? undefined);
  };
  return (
    <div className="character-select">
      <h2>Choisis ton personnage</h2>
      <div className="character-grid">
        <Canvas
          className="character-canvas"
          dpr={Math.min(1.5, window.devicePixelRatio || 1)}
          camera={{
            position: [0, PREVIEW.height, PREVIEW.distance],
            fov: PREVIEW.fov,
            near: 0.1,
            far: 50,
          }}
          onCreated={({ camera }) => camera.lookAt(0, PREVIEW.lookY, 0)}
        >
          <Previews />
        </Canvas>
        {CHARACTERS.map((c) => (
          <Card key={c.id} id={c.id} selected={c.id === current} onChoose={() => choose(c.id)} />
        ))}
      </div>
      <button type="button" className="btn" onClick={() => closeCharacterSelect()}>
        Plus tard
      </button>
    </div>
  );
}
