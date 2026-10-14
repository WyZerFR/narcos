import { useEffect, useMemo } from 'react';
import { MeshBasicMaterial, MeshLambertMaterial } from 'three';
import { gameData } from '@narco/shared';
import { applyCutout } from '../city/cutout';
import { buildRoom } from './buildRoom';
import { LabProps } from './LabProps';
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
      {interior.stations.some((st) => st.kind === 'pot' || st.kind === 'rack') && (
        <LabProps room={room} interior={interior} />
      )}
    </>
  );
}
