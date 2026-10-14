import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  Color,
  IcosahedronGeometry,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
  type InstancedMesh,
} from 'three';
import { gameData, potProgress, potStatus, type Interior } from '@narco/shared';
import type { GameRoom } from '../../net/connection';
import { gameNow, readPot, readRack } from '../../net/gameView';
import { Batch, mix, shade } from '../city/batch';

const { palette } = gameData.config;
const { economy } = gameData;
/** Mise à jour des plantes : la pousse est lente, 4 fois par seconde suffit. */
const REFRESH_S = 0.25;
/** Hauteur du terreau dans le pot (cf. buildRoom). */
const SOIL_Y = 0.66;

const m = new Matrix4();
const q = new Quaternion();
const p = new Vector3();
const s = new Vector3();

/**
 * Éléments vivants du labo, lus dans l'état serveur : plantes des pots (taille = progression)
 * et bottes suspendues à l'étendoir (vert → brun en séchant). 2 draw calls au total.
 */
export function LabProps({ room, interior }: { room: GameRoom; interior: Interior }) {
  const pots = useMemo(() => interior.stations.filter((st) => st.kind === 'pot'), [interior]);
  const rack = useMemo(() => interior.stations.find((st) => st.kind === 'rack'), [interior]);
  const capacity = economy.lab.rackCapacity;

  const plantRef = useRef<InstancedMesh>(null);
  const bundleRef = useRef<InstancedMesh>(null);
  const acc = useRef(REFRESH_S);

  const { plantGeo, bundleGeo, material } = useMemo(() => {
    const plant = new Batch();
    plant.block(0, 0, 0, 0.06, 0.5, 0.06, shade(palette.vegetation, 0.6));
    plant.add(new IcosahedronGeometry(0.32, 0), new Color(1, 1, 1), 0, 0.55, 0);
    plant.add(new IcosahedronGeometry(0.22, 0), new Color(1, 1, 1), 0.15, 0.8, 0.05, 0.5);
    const bundle = new Batch();
    bundle.box(0, -0.18, 0, 0.18, 0.36, 0.14, new Color(1, 1, 1));
    bundle.box(0, 0.02, 0, 0.04, 0.08, 0.04, shade(palette.ground, 2));
    return {
      plantGeo: plant.build(),
      bundleGeo: bundle.build(),
      material: new MeshLambertMaterial({ vertexColors: true }),
    };
  }, []);

  useLayoutEffect(
    () => () => {
      plantGeo.dispose();
      bundleGeo.dispose();
      material.dispose();
    },
    [plantGeo, bundleGeo, material],
  );

  useFrame((_, dt) => {
    acc.current += dt;
    if (acc.current < REFRESH_S) return;
    acc.current = 0;
    const now = gameNow();
    const green = shade(palette.vegetation, 1.7);
    const ready = shade(palette.vegetation, 2.6);

    const plants = plantRef.current;
    if (plants) {
      pots.forEach((st, i) => {
        const pot = readPot(room, st.id);
        const strain = economy.strains.find((x) => x.id === pot?.strainId) ?? economy.strains[0]!;
        const growth = pot?.planted ? potProgress(pot, now, strain) : 0;
        const k = pot?.planted ? 0.2 + 0.8 * growth : 0;
        q.identity();
        m.compose(p.set(st.position.x, SOIL_Y, st.position.z), q, s.set(k, k, k));
        plants.setMatrixAt(i, m);
        const thirsty = pot?.planted && potStatus(pot, now, strain) === 'needs_water';
        plants.setColorAt(
          i,
          growth >= 1 ? ready : thirsty ? mix(palette.vegetation, palette.neon, 0.45) : green,
        );
      });
      plants.instanceMatrix.needsUpdate = true;
      if (plants.instanceColor) plants.instanceColor.needsUpdate = true;
    }

    const bundles = bundleRef.current;
    if (bundles && rack) {
      const dryMs = economy.strains[0]!.dryingSeconds * 1000;
      const flat = readRack(room).flatMap((e) => Array.from({ length: e.qty }, () => e.readyAt));
      for (let i = 0; i < capacity; i++) {
        const readyAt = flat[i];
        const step = rack.size.w / (capacity + 1);
        const x = rack.position.x - rack.size.w / 2 + step * (i + 1);
        const k = readyAt === undefined ? 0 : 1;
        m.compose(p.set(x, 2, rack.position.z), q.identity(), s.set(k, k, k));
        bundles.setMatrixAt(i, m);
        const dried =
          readyAt === undefined ? 0 : Math.min(1, Math.max(0, 1 - (readyAt - now) / dryMs));
        bundles.setColorAt(i, new Color(palette.vegetation).lerp(shade(palette.neon, 0.45), dried));
      }
      bundles.instanceMatrix.needsUpdate = true;
      if (bundles.instanceColor) bundles.instanceColor.needsUpdate = true;
    }
  });

  return (
    <>
      <instancedMesh
        ref={plantRef}
        args={[plantGeo, material, Math.max(1, pots.length)]}
        frustumCulled={false}
      />
      <instancedMesh ref={bundleRef} args={[bundleGeo, material, capacity]} frustumCulled={false} />
    </>
  );
}
