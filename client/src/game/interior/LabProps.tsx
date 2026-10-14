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
import { gameData, potProgress, potStatus, rotateOffset, rotatedSize } from '@narco/shared';
import type { GameRoom } from '../../net/connection';
import { gameNow, readPot, readRack } from '../../net/gameView';
import { Batch, mix, shade } from '../city/batch';
import { labFixtures } from '../fixtureState';

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
const UP = new Vector3(0, 1, 0);

/**
 * Éléments vivants du labo, lus dans l'état serveur : plantes des pots (taille = progression)
 * et bottes suspendues aux étendoirs posés (vert → brun en séchant), à la position réelle des
 * meubles. 2 draw calls au total, instances dimensionnées par les plafonds de economy.json.
 */
export function LabProps({ room }: { room: GameRoom }) {
  const { maxPerType } = economy.lab.furniture;
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

    const fixtures = labFixtures(room);
    const pots = fixtures.filter((f) => f.accepts === 'pot').slice(0, maxPerType.pot);
    const racks = fixtures
      .filter((f) => f.accepts === 'drying_rack')
      .slice(0, maxPerType.drying_rack);
    const plants = plantRef.current;
    if (plants) {
      for (let i = pots.length; i < maxPerType.pot; i++) {
        m.compose(p.set(0, -10, 0), q.identity(), s.set(0, 0, 0));
        plants.setMatrixAt(i, m);
      }
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
    if (bundles) {
      const dryMs = economy.strains[0]!.dryingSeconds * 1000;
      for (let i = racks.length * capacity; i < maxPerType.drying_rack * capacity; i++) {
        m.compose(p.set(0, -10, 0), q.identity(), s.set(0, 0, 0));
        bundles.setMatrixAt(i, m);
      }
      racks.forEach((rack, r) => {
        const along = rotatedSize(rack.size, rack.rot).w; // longueur des fils, avant rotation
        const flat = readRack(room, rack.id).flatMap((e) =>
          Array.from({ length: e.qty }, () => e.readyAt),
        );
        for (let j = 0; j < capacity; j++) {
          const i = r * capacity + j;
          const readyAt = flat[j];
          const step = along / (capacity + 1);
          const o = rotateOffset(-along / 2 + step * (j + 1), 0, rack.rot);
          const k = readyAt === undefined ? 0 : 1;
          q.setFromAxisAngle(UP, (rack.rot * Math.PI) / 2);
          m.compose(p.set(rack.position.x + o.x, 2, rack.position.z + o.z), q, s.set(k, k, k));
          bundles.setMatrixAt(i, m);
          const dried =
            readyAt === undefined ? 0 : Math.min(1, Math.max(0, 1 - (readyAt - now) / dryMs));
          bundles.setColorAt(
            i,
            new Color(palette.vegetation).lerp(shade(palette.neon, 0.45), dried),
          );
        }
      });
      bundles.instanceMatrix.needsUpdate = true;
      if (bundles.instanceColor) bundles.instanceColor.needsUpdate = true;
    }
  });

  return (
    <>
      <instancedMesh
        ref={plantRef}
        args={[plantGeo, material, maxPerType.pot]}
        frustumCulled={false}
      />
      <instancedMesh
        ref={bundleRef}
        args={[bundleGeo, material, capacity * maxPerType.drying_rack]}
        frustumCulled={false}
      />
    </>
  );
}
