import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  AnimationMixer,
  Color,
  RingGeometry,
  Vector3,
  type AnimationAction,
  type Group,
  type Material,
  type MeshLambertMaterial,
  type Object3D,
} from 'three';
import { gameData, smoothFactor } from '@narco/shared';
import { FRAME_PRIORITY } from '../framePriority';
import { instantiate, useCharacterAsset, type CharacterAsset } from './characterAssets';

const { world, characters: rules, palette } = gameData.config;
const SIZE = world.playerSize;
const RING = new RingGeometry(rules.ring.innerRadius, rules.ring.outerRadius, 32).rotateX(
  -Math.PI / 2,
);

/**
 * Corps d'un joueur : modèle 3D de son personnage (cloné, animé), ou cube de repli tant que le
 * modèle charge ou s'il a échoué. Anneau au sol à la couleur du joueur dans tous les cas.
 */
export function CharacterBody({
  characterId,
  color,
  ghost,
}: {
  characterId: string;
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
        <Model asset={asset} color={color} ghost={ghost} />
      ) : (
        <CubeBody color={color} ghost={ghost} />
      )}
    </>
  );
}

/** Cube historique : repli sans modèle. */
export function CubeBody({ color, ghost }: { color: string; ghost: boolean }) {
  return (
    <>
      <mesh position={[0, SIZE / 2, 0]}>
        <boxGeometry args={[SIZE, SIZE, SIZE]} />
        <meshLambertMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.45}
          transparent={ghost}
          opacity={ghost ? 0.35 : 1}
        />
      </mesh>
      {/* « nez » : indique la direction du regard */}
      <mesh position={[0, SIZE * 0.7, SIZE * 0.55]}>
        <boxGeometry args={[SIZE * 0.3, SIZE * 0.2, SIZE * 0.2]} />
        <meshLambertMaterial color={palette.sky} />
      </mesh>
    </>
  );
}

function materialsOf(root: Object3D): MeshLambertMaterial[] {
  const list: MeshLambertMaterial[] = [];
  root.traverse((o) => {
    const m = (o as { material?: Material }).material;
    if (m) list.push(m as MeshLambertMaterial);
  });
  return list;
}

function Model({ asset, color, ghost }: { asset: CharacterAsset; color: string; ghost: boolean }) {
  const wrapper = useRef<Group>(null);
  const root = useMemo(() => instantiate(asset), [asset]);
  const anim = useMemo(() => {
    const mixer = new AnimationMixer(root);
    const action = (name: string | undefined): AnimationAction | null => {
      const clip = name ? asset.clips.find((c) => c.name === name) : undefined;
      return clip ? mixer.clipAction(clip) : null;
    };
    const idle = action(asset.character.animations.idle);
    const walk = action(asset.character.animations.walk);
    idle?.play();
    return { mixer, idle, walk, current: idle };
  }, [asset, root]);
  const motion = useRef({ last: new Vector3(NaN, 0, 0), speed: 0, time: 0 });

  // Teinte légère à la couleur du joueur (lisible de nuit) ; fantôme si déconnecté.
  useEffect(() => {
    for (const m of materialsOf(root)) {
      m.emissive = new Color(color);
      m.emissiveIntensity = rules.tint;
      m.transparent = ghost;
      m.opacity = ghost ? 0.35 : 1;
      m.needsUpdate = true;
    }
  }, [root, color, ghost]);

  useEffect(
    () => () => {
      anim.mixer.stopAllAction();
      anim.mixer.uncacheRoot(root);
      for (const m of materialsOf(root)) m.dispose();
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
