import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Color, type DirectionalLight, type PointLight } from 'three';
import { gameData, themedPalette, themeOf, type Theme, type ThemeId } from '@narco/shared';
import { localPlayer } from './localPlayer';
import { FRAME_PRIORITY } from './framePriority';

const { config } = gameData;

const lightColor = (l: { color: string; scale: number }) =>
  new Color(l.color).multiplyScalar(l.scale);

/** Le soleil (ou la lune) : position relative au joueur ; ombre réelle seulement si `shadows`. */
function Sun({ theme, shadows }: { theme: Theme; shadows: boolean }) {
  const ref = useRef<DirectionalLight>(null);
  const scene = useThree((s) => s.scene);
  const { mapSize, radius } = config.render.realShadows;
  useEffect(() => {
    const light = ref.current;
    if (!light) return;
    scene.add(light.target);
    const cam = light.shadow.camera;
    cam.left = cam.bottom = -radius;
    cam.right = cam.top = radius;
    cam.updateProjectionMatrix();
    return () => void scene.remove(light.target);
  }, [scene, radius]);
  useFrame(() => {
    const light = ref.current;
    if (!light || !shadows || !localPlayer.initialized) return;
    // la carte d'ombre couvre une zone autour du joueur : lumière et cible le suivent
    const [x, y, z] = theme.sun.position;
    light.position.set(localPlayer.x + x, y, localPlayer.z + z);
    light.target.position.set(localPlayer.x, 0, localPlayer.z);
  }, FRAME_PRIORITY.camera);
  return (
    <directionalLight
      ref={ref}
      position={theme.sun.position}
      intensity={theme.sun.intensity}
      color={lightColor(theme.sun)}
      castShadow={shadows}
      shadow-mapSize={[mapSize, mapSize]}
      shadow-bias={-0.0008}
    />
  );
}

/** Seule lumière ponctuelle du jeu : elle suit le joueur local (aucune par devanture). */
function PlayerLight({ light }: { light: NonNullable<Theme['playerLight']> }) {
  const ref = useRef<PointLight>(null);
  useFrame(() => {
    if (ref.current && localPlayer.initialized)
      ref.current.position.set(localPlayer.x, light.height, localPlayer.z);
  }, FRAME_PRIORITY.camera);
  return (
    <pointLight
      ref={ref}
      color={lightColor(light)}
      intensity={light.intensity}
      distance={light.distance}
      decay={light.decay}
    />
  );
}

/**
 * Ambiance du thème (`config.theme`) : fond, brouillard (rue seulement), ambiante ou hémisphère,
 * soleil, lumière du joueur. Au plus `config.render.maxDynamicLights` lumières dynamiques.
 */
export function Ambience({
  themeId,
  interior = false,
  shadows = false,
}: {
  themeId: ThemeId;
  interior?: boolean;
  shadows?: boolean;
}) {
  const theme = themeOf(config, themeId);
  const palette = themedPalette(config, themeId);
  // intérieurs : lumière propre au thème (jour : chaude), sinon celle de la rue
  const ambient = (interior && theme.interiorAmbient) || theme.ambient;
  // Fond derrière les murs d'un intérieur : le ciel, très assombri.
  const background = useMemo(
    () => (interior ? new Color(palette.sky).multiplyScalar(0.4) : new Color(palette.sky)),
    [interior, palette.sky],
  );
  return (
    <>
      <color attach="background" args={[background]} />
      {!interior && <fog attach="fog" args={[palette.sky, theme.fog.near, theme.fog.far]} />}
      {ambient && <ambientLight color={lightColor(ambient)} intensity={ambient.intensity} />}
      {theme.hemisphere && (
        <hemisphereLight
          args={[
            lightColor(theme.hemisphere.sky),
            lightColor(theme.hemisphere.ground),
            theme.hemisphere.intensity,
          ]}
        />
      )}
      <Sun theme={theme} shadows={shadows && !interior} />
      {theme.playerLight && <PlayerLight light={theme.playerLight} />}
    </>
  );
}
