import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  AnimationMixer,
  Float32BufferAttribute,
  RingGeometry,
  type AnimationAction,
  type BufferGeometry,
  type Group,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { appearanceKey, gameData, Locomotion, type Appearance, type Gait } from '@narco/shared';
import { FRAME_PRIORITY } from '../framePriority';
import {
  applyAppearance,
  applyBodyState,
  disposeMaterials,
  instantiate,
  useCharacterAsset,
  type CharacterAsset,
} from './characterAssets';

const { world, characters: rules, palette } = gameData.config;
const SIZE = world.playerSize;
const RING = ringWithOutline();

/**
 * Anneau au sol : bande à la couleur du joueur (couleur de sommet blanche) bordée d'un liseré
 * sombre (couleur du joueur assombrie), fusionnés : 1 draw call, lisible sur asphalte et herbe.
 */
export function ringWithOutline(): BufferGeometry {
  const { innerRadius, outerRadius, outline, outlineShade } = rules.ring;
  const parts = [
    { g: new RingGeometry(innerRadius, outerRadius, 32), k: 1 },
    { g: new RingGeometry(outerRadius, outerRadius + outline, 32), k: outlineShade },
    { g: new RingGeometry(Math.max(0, innerRadius - outline), innerRadius, 32), k: outlineShade },
  ].map(({ g, k }) => {
    const n = g.attributes.position!.count;
    g.setAttribute('color', new Float32BufferAttribute(new Array(n * 3).fill(k), 3));
    return g;
  });
  const merged = mergeGeometries(parts)!.rotateX(-Math.PI / 2);
  for (const p of parts) p.dispose();
  return merged;
}

/**
 * Corps d'un joueur : modèle 3D de son personnage (cloné, animé), ou cube de repli tant que le
 * modèle charge ou s'il a échoué. La couleur du joueur ne teinte que l'anneau au sol (et la
 * pastille de nom) : le corps garde les couleurs de son modèle, ou celles choisies par slot.
 *
 * Locomotion (`shared/src/locomotion.ts`) mesurée sur la position affichée du groupe parent
 * (prédite pour soi, interpolée pour les autres) : allure, fondus, cap lissé, penchement.
 */
export function CharacterBody({
  characterId,
  appearance,
  color,
  ghost,
  heading,
}: {
  characterId: string;
  appearance: Appearance;
  color: string;
  ghost: boolean;
  /** Cap voulu (rad), lu à chaque frame. */
  heading: () => number;
}) {
  const asset = useCharacterAsset(characterId);
  const body = useRef<Group>(null);
  const loco = useMemo(() => new Locomotion(rules.locomotion, heading()), []);
  const animate = useRef<((dt: number) => void) | null>(null);
  useFrame((_, rawDt) => {
    const g = body.current;
    const player = g?.parent;
    if (!g || !player) return;
    const dt = Math.min(rawDt, 0.1);
    loco.step(player.position.x, player.position.z, heading(), dt);
    g.rotation.set(loco.lean, loco.heading, 0, 'YXZ');
    g.position.y = loco.bobOffset();
    animate.current?.(dt);
  }, FRAME_PRIORITY.animation);
  return (
    <>
      <mesh geometry={RING} position={[0, 0.02, 0]}>
        <meshBasicMaterial
          vertexColors
          color={color}
          transparent={ghost}
          opacity={ghost ? 0.35 : 1}
        />
      </mesh>
      <group ref={body}>
        {typeof asset === 'object' ? (
          <Model
            asset={asset}
            appearance={appearance}
            ghost={ghost}
            loco={loco}
            animate={animate}
          />
        ) : (
          <CubeBody ghost={ghost} />
        )}
      </group>
    </>
  );
}

const GAITS: readonly Gait[] = ['idle', 'walk', 'run'];

/** Cube historique : repli sans modèle, neutre (la couleur du joueur est sur l'anneau). */
export function CubeBody({ ghost }: { ghost: boolean }) {
  return (
    <>
      <mesh position={[0, SIZE / 2, 0]}>
        <boxGeometry args={[SIZE, SIZE, SIZE]} />
        <meshLambertMaterial
          flatShading
          color={palette.wall}
          transparent={ghost}
          opacity={ghost ? 0.35 : 1}
        />
      </mesh>
      {/* « nez » : indique la direction du regard */}
      <mesh position={[0, SIZE * 0.7, SIZE * 0.55]}>
        <boxGeometry args={[SIZE * 0.3, SIZE * 0.2, SIZE * 0.2]} />
        <meshLambertMaterial flatShading color={palette.sky} />
      </mesh>
    </>
  );
}

function Model({
  asset,
  appearance,
  ghost,
  loco,
  animate,
}: {
  asset: CharacterAsset;
  appearance: Appearance;
  ghost: boolean;
  loco: Locomotion;
  animate: { current: ((dt: number) => void) | null };
}) {
  const root = useMemo(() => instantiate(asset), [asset]);
  const anim = useMemo(() => {
    const mixer = new AnimationMixer(root);
    const names = gameData.config.characters.animations;
    const actions: Partial<Record<Gait, AnimationAction>> = {};
    for (const g of GAITS) {
      const clip = names[g] ? asset.clips.find((c) => c.name === names[g]) : undefined;
      if (clip) actions[g] = mixer.clipAction(clip);
    }
    return { mixer, actions };
  }, [asset, root]);

  // Clips disponibles → allures possibles ; tous joués, mélangés par leurs poids.
  useEffect(() => {
    const { actions } = anim;
    loco.clips = { walk: !!actions.walk, run: !!actions.run };
    for (const g of GAITS) actions[g]?.setEffectiveWeight(loco.weights[g]).play();
    animate.current = (dt) => {
      const weights = { ...loco.weights };
      // allure sans clip : son poids revient à l'attente (le balancement prend le relais)
      for (const g of GAITS) if (!actions[g] && g !== 'idle') weights.idle += weights[g];
      const lead = loco.gait === 'run' ? actions.run : actions.walk;
      for (const g of GAITS) {
        const a = actions[g];
        if (!a) continue;
        // une allure qui revient en fondu reprend la phase de pas de celle qui mène : pas de
        // pied qui saute entre marche et course
        if (a.getEffectiveWeight() === 0 && weights[g] > 0 && g !== 'idle' && lead && lead !== a)
          a.time = (lead.time / lead.getClip().duration) * a.getClip().duration;
        a.setEffectiveWeight(weights[g]);
        a.timeScale = loco.timeScale(g);
      }
      anim.mixer.update(dt);
    };
    return () => {
      animate.current = null;
    };
  }, [anim, loco, animate]);

  // Fantôme si déconnecté ; aucune teinte : le corps garde les couleurs du modèle.
  useEffect(() => applyBodyState(root, ghost), [root, ghost]);
  // couleurs par slot : uniforms seulement, ni nouveau matériau ni recompilation
  const look = appearanceKey(appearance);
  useEffect(() => applyAppearance(root, appearance), [root, look]);

  useEffect(
    () => () => {
      anim.mixer.stopAllAction();
      anim.mixer.uncacheRoot(root);
      disposeMaterials(root);
    },
    [anim, root],
  );

  return <primitive object={root} />;
}
