import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { AnimationMixer, RingGeometry, Vector3, type AnimationAction, type Group } from 'three';
import { appearanceKey, gameData, smoothFactor, type Appearance } from '@narco/shared';
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
const RING = new RingGeometry(rules.ring.innerRadius, rules.ring.outerRadius, 32).rotateX(
  -Math.PI / 2,
);

/**
 * Corps d'un joueur : modèle 3D de son personnage (cloné, animé), ou cube de repli tant que le
 * modèle charge ou s'il a échoué. La couleur du joueur ne teinte que l'anneau au sol (et la
 * pastille de nom) : le corps garde les couleurs de son modèle, ou celles choisies par slot.
 */
export function CharacterBody({
  characterId,
  appearance,
  color,
  ghost,
}: {
  characterId: string;
  appearance: Appearance;
  color: string;
  ghost: boolean;
}) {
  const asset = useCharacterAsset(characterId);
  return (
    <>
      <mesh geometry={RING} position={[0, 0.02, 0]}>
        <meshBasicMaterial color={color} transparent={ghost} opacity={ghost ? 0.35 : 1} />
      </mesh>
      {typeof asset === 'object' ? (
        <Model asset={asset} appearance={appearance} ghost={ghost} />
      ) : (
        <CubeBody ghost={ghost} />
      )}
    </>
  );
}

/** Cube historique : repli sans modèle, neutre (la couleur du joueur est sur l'anneau). */
export function CubeBody({ ghost }: { ghost: boolean }) {
  return (
    <>
      <mesh position={[0, SIZE / 2, 0]}>
        <boxGeometry args={[SIZE, SIZE, SIZE]} />
        <meshLambertMaterial color={palette.wall} transparent={ghost} opacity={ghost ? 0.35 : 1} />
      </mesh>
      {/* « nez » : indique la direction du regard */}
      <mesh position={[0, SIZE * 0.7, SIZE * 0.55]}>
        <boxGeometry args={[SIZE * 0.3, SIZE * 0.2, SIZE * 0.2]} />
        <meshLambertMaterial color={palette.sky} />
      </mesh>
    </>
  );
}

function Model({
  asset,
  appearance,
  ghost,
}: {
  asset: CharacterAsset;
  appearance: Appearance;
  ghost: boolean;
}) {
  const wrapper = useRef<Group>(null);
  const root = useMemo(() => instantiate(asset), [asset]);
  const anim = useMemo(() => {
    const mixer = new AnimationMixer(root);
    const action = (name: string | undefined): AnimationAction | null => {
      const clip = name ? asset.clips.find((c) => c.name === name) : undefined;
      return clip ? mixer.clipAction(clip) : null;
    };
    const idle = action(gameData.config.characters.animations.idle);
    const walk = action(gameData.config.characters.animations.walk);
    idle?.play();
    return { mixer, idle, walk, current: idle };
  }, [asset, root]);
  const motion = useRef({ last: new Vector3(NaN, 0, 0), speed: 0, time: 0 });

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

  useFrame((_, rawDt) => {
    const player = wrapper.current?.parent;
    if (!player) return;
    const dt = Math.min(rawDt, 0.1);
    const mo = motion.current;
    const p = player.position;
    const dist = Number.isNaN(mo.last.x) ? 0 : Math.hypot(p.x - mo.last.x, p.z - mo.last.z);
    mo.last.copy(p);
    if (dt > 0) mo.speed += (dist / dt - mo.speed) * smoothFactor(rules.speedSmoothing, dt);
    const moving = mo.speed > rules.moveThreshold;

    const next = moving ? (anim.walk ?? anim.idle) : anim.idle;
    if (next && next !== anim.current) {
      next.reset().play();
      if (anim.current) next.crossFadeFrom(anim.current, rules.animationFadeSeconds, false);
      anim.current = next;
    }
    if (anim.current) anim.mixer.update(dt);
    else {
      // pas d'animation dans le fichier : léger balancement en marchant
      mo.time += dt;
      root.position.y = moving
        ? Math.abs(Math.sin(mo.time * rules.bob.speed)) * rules.bob.height
        : 0;
    }
  }, FRAME_PRIORITY.animation);

  return (
    <group ref={wrapper}>
      <primitive object={root} />
    </group>
  );
}
