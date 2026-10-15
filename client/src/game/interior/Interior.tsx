import { useEffect, useMemo } from 'react';
import { MeshBasicMaterial, MeshLambertMaterial } from 'three';
import { gameData } from '@narco/shared';
import { applyCutout } from '../city/cutout';
import { buildRoom } from './buildRoom';
import { FixtureDrag } from './FixtureDrag';
import { FixtureProps } from './FixtureProps';
import { LabProps } from './LabProps';
import { PlacementGhost } from './PlacementGhost';
import type { GameRoom } from '../../net/connection';

/** Rendu d'un intérieur (`zones.json`) : pièce fusionnée, découpe des murs devant le joueur. */
export function Interior({
  room,
  zoneId,
  glowBoost,
}: {
  room: GameRoom;
  zoneId: string;
  glowBoost: number;
}) {
  const interior = gameData.interiors.get(zoneId)!;
  const geometry = useMemo(() => buildRoom(interior), [interior]);
  const materials = useMemo(
    () => ({
      solid: applyCutout(new MeshLambertMaterial({ vertexColors: true })),
      glow: applyCutout(new MeshBasicMaterial({ vertexColors: true, toneMapped: false })),
    }),
    [],
  );

  useEffect(() => {
    materials.glow.color.setScalar(glowBoost);
  }, [materials, glowBoost]);

  useEffect(
    () => () => {
      geometry.solid.dispose();
      geometry.glow.dispose();
      materials.solid.dispose();
      materials.glow.dispose();
    },
    [geometry, materials],
  );

  return (
    <>
      <mesh geometry={geometry.solid} material={materials.solid} />
      <mesh geometry={geometry.glow} material={materials.glow} />
      {interior.furnishable && (
        <>
          <FixtureProps room={room} interior={interior} glowBoost={glowBoost} />
          <LabProps room={room} />
          <PlacementGhost room={room} interior={interior} />
          <FixtureDrag room={room} />
        </>
      )}
    </>
  );
}
