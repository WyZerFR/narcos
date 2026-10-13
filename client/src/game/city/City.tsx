import { useEffect, useMemo } from 'react';
import { MeshBasicMaterial, MeshLambertMaterial } from 'three';
import { gameData } from '@narco/shared';
import { buildCity } from './buildCity';
import { Decor } from './Decor';
import { shade } from './batch';

const { palette } = gameData.config;
// Teintes de la palette très éclaircies : lumière de nuit bleutée, assez forte pour lire les volumes.
const SKY_LIGHT = shade(palette.wall, 10);
const GROUND_LIGHT = shade(palette.ground, 6);
const MOON = shade(palette.wall, 9);

/** Ambiance de nuit : 2 lumières seulement (hémisphère + lune), brouillard couleur ciel. */
export function NightAmbience() {
  return (
    <>
      <color attach="background" args={[palette.sky]} />
      <fog attach="fog" args={[palette.sky, 35, 95]} />
      {/* Couleurs de lumière = teintes de la palette éclaircies (nuit bleutée, pas de noir pur). */}
      <hemisphereLight args={[SKY_LIGHT, GROUND_LIGHT, 1.1]} />
      <directionalLight position={[-12, 25, 10]} intensity={1.3} color={MOON} />
    </>
  );
}

/** Le quartier : 2 géométries fusionnées (murs + lumières) + décor instancié. */
export function City({ glowBoost }: { glowBoost: number }) {
  const geometry = useMemo(() => buildCity(gameData), []);
  const solidMaterial = useMemo(() => new MeshLambertMaterial({ vertexColors: true }), []);
  const glowMaterial = useMemo(
    () => new MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    [],
  );

  // En qualité moyen/haut, les émissifs passent au-dessus de 1 pour déclencher le bloom.
  useEffect(() => {
    glowMaterial.color.setScalar(glowBoost);
  }, [glowMaterial, glowBoost]);

  useEffect(
    () => () => {
      geometry.solid.dispose();
      geometry.glow.dispose();
      solidMaterial.dispose();
      glowMaterial.dispose();
    },
    [geometry, solidMaterial, glowMaterial],
  );

  return (
    <>
      <mesh geometry={geometry.solid} material={solidMaterial} />
      <mesh geometry={geometry.glow} material={glowMaterial} />
      <Decor data={gameData} solidMaterial={solidMaterial} glowMaterial={glowMaterial} />
    </>
  );
}
