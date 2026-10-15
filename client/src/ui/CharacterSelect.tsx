import { useEffect, useMemo, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { AnimationMixer, type Group } from 'three';
import { appearanceKey, gameData, type Appearance } from '@narco/shared';
import type { GameRoom } from '../net/connection';
import { subscribeState } from '../net/gameView';
import { connection } from '../net/connection';
import {
  applyAppearance,
  disposeMaterials,
  instantiate,
  useCharacterAsset,
  type CharacterAsset,
} from '../game/characters/characterAssets';
import { lookOf } from '../game/Players';
import { CharacterColors } from './CharacterColors';
import { closeCharacterSelect, useCharacterSelectStep } from './characterSelectStore';

const CHARACTERS = [...gameData.characters.values()];
const { categories: CATEGORIES, previewSpinSpeed, preview: PREVIEW } = gameData.config.characters;
const NO_COLORS: Appearance = {};

/** Personnage et couleurs du joueur local, suivis dans l'état du serveur. */
function useMyLook(room: GameRoom) {
  const read = () => lookOf(room.state.players?.get(connection.playerId) ?? {});
  const [look, setLook] = useState(read);
  useEffect(() => subscribeState(room, () => setLook(read())), [room]);
  return look;
}

/** Aperçu animé qui tourne lentement, au centre du canvas. */
function Preview({ asset, appearance }: { asset: CharacterAsset; appearance: Appearance }) {
  const root = useMemo(() => instantiate(asset), [asset]);
  const look = appearanceKey(appearance);
  useEffect(() => applyAppearance(root, appearance), [root, look]);
  const mixer = useMemo(() => {
    const m = new AnimationMixer(root);
    const idle = asset.clips.find((c) => c.name === gameData.config.characters.animations.idle);
    if (idle) m.clipAction(idle).play();
    return m;
  }, [asset, root]);
  useEffect(
    () => () => {
      mixer.stopAllAction();
      disposeMaterials(root);
    },
    [mixer, root],
  );
  useFrame((_, dt) => {
    mixer.update(Math.min(dt, 0.1));
    root.rotation.y += previewSpinSpeed * Math.min(dt, 0.1);
  });
  return <primitive object={root as Group} />;
}

/**
 * Un seul canvas léger (la scène du jeu n'est pas montée pendant ce temps : un seul contexte
 * WebGL sur iPad). Il ne capte aucun clic : R3F pose pointer-events: auto en style inline.
 */
export function PreviewCanvas({
  asset,
  appearance = NO_COLORS,
}: {
  asset: CharacterAsset | null;
  appearance?: Appearance;
}) {
  return (
    <Canvas
      style={{ pointerEvents: 'none' }}
      dpr={Math.min(1.5, window.devicePixelRatio || 1)}
      camera={{
        position: [0, PREVIEW.height, PREVIEW.distance],
        fov: PREVIEW.fov,
        near: 0.1,
        far: 50,
      }}
      onCreated={({ camera }) => camera.lookAt(0, PREVIEW.lookY, 0)}
    >
      <hemisphereLight args={[gameData.config.palette.sky, gameData.config.palette.ground, 2.2]} />
      <directionalLight position={[2, 5, 4]} intensity={1.6} />
      {asset && <Preview key={asset.character.id} asset={asset} appearance={appearance} />}
    </Canvas>
  );
}

/**
 * Sélection du personnage : onglets par catégorie, carrousel à flèches, un seul modèle chargé
 * (paresseusement) à la fois ; « Choisir » ouvre ses couleurs (étape directe depuis Options).
 */
export function CharacterSelect({ room, code }: { room: GameRoom; code: string | null }) {
  const look = useMyLook(room);
  const current = look.characterId;
  const step = useCharacterSelectStep();
  const [colorsFor, setColorsFor] = useState<string | null>(() =>
    step === 'colors' ? current : null,
  );
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      CHARACTERS.findIndex((c) => c.id === current),
    ),
  );
  // l'état du serveur arrive après le premier rendu : on se place sur le personnage actuel
  useEffect(
    () =>
      setIndex(
        Math.max(
          0,
          CHARACTERS.findIndex((c) => c.id === current),
        ),
      ),
    [current],
  );
  const shown = CHARACTERS[index] ?? CHARACTERS[0]!;
  const asset = useCharacterAsset(shown.id);
  const turn = (d: number) => setIndex((i) => (i + d + CHARACTERS.length) % CHARACTERS.length);
  const choose = (characterId: string) => setColorsFor(characterId);
  if (colorsFor)
    return (
      <CharacterColors
        room={room}
        code={code}
        characterId={colorsFor}
        initial={colorsFor === current ? look.appearance : NO_COLORS}
        onBack={() => setColorsFor(null)}
      />
    );
  return (
    <div className="character-select">
      <h2>Choisis ton personnage</h2>
      <div className="character-tabs">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            type="button"
            className={`btn${shown.category === cat.id ? ' primary' : ''}`}
            onClick={() => setIndex(CHARACTERS.findIndex((c) => c.category === cat.id))}
            disabled={!CHARACTERS.some((c) => c.category === cat.id)}
          >
            {cat.name}
          </button>
        ))}
      </div>
      <div className="character-carousel">
        <button
          type="button"
          className="btn character-arrow"
          aria-label="Personnage précédent"
          onClick={() => turn(-1)}
        >
          ◀
        </button>
        <div className={`character-stage${shown.id === current ? ' selected' : ''}`}>
          <PreviewCanvas asset={typeof asset === 'object' ? asset : null} />
          {asset === 'loading' && <span className="character-status">Chargement…</span>}
          {asset === 'error' && <span className="character-status">Modèle indisponible</span>}
        </div>
        <button
          type="button"
          className="btn character-arrow"
          aria-label="Personnage suivant"
          onClick={() => turn(1)}
        >
          ▶
        </button>
      </div>
      <div className="character-name">
        {shown.name}
        <span className="character-count">
          {index + 1} / {CHARACTERS.length}
        </span>
      </div>
      <div className="character-actions">
        <button type="button" className="btn primary" onClick={() => choose(shown.id)}>
          {shown.id === current ? 'Garder' : 'Choisir'}
        </button>
        <button type="button" className="btn" onClick={() => closeCharacterSelect()}>
          Plus tard
        </button>
      </div>
    </div>
  );
}
