import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  MeshBasicMaterial,
  Vector2,
  Vector3,
  type Camera,
  type Material,
  type Texture,
} from 'three';
import { gameData, themeOf, type ThemeId } from '@narco/shared';
import { themedData } from './themedData';
import { localPlayer } from '../localPlayer';
import { buildCity } from './buildCity';
import { SEA_GROUP } from './areaBatches';
import { currentArea, useLoadedAreas } from '../areaStreaming';
import { Decor } from './Decor';
import { Halos } from './Halos';
import { Panels } from './Panels';
import { GrassTufts } from './GrassTufts';
import { PropKits } from './PropKits';
import { mergedPropIds, propKitItems } from './propPlacements';
import { applyEmission, outlineMaterial, shadedMaterial } from '../materials';
import { applyCutout, cutoutUniforms, getCutout } from './cutout';

const { world } = gameData.config;

const playerCenter = new Vector3();
const projected = new Vector3();
const edge = new Vector3();
const right = new Vector3();
const buffer = new Vector2();

/** Pixels (tampon de rendu) entre le centre du joueur et un point à `meters` sur sa droite écran. */
function screenRadius(camera: Camera, meters: number, width: number, height: number): number {
  edge.copy(playerCenter).addScaledVector(right, meters).project(camera);
  return Math.hypot(((edge.x - projected.x) / 2) * width, ((edge.y - projected.y) / 2) * height);
}

/** Met à jour les uniforms de découpe : position du joueur local, projection, rayon en pixels. */
function CutoutDriver() {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  useFrame(() => {
    const cfg = getCutout();
    const u = cutoutUniforms;
    if (!cfg.enabled || !localPlayer.initialized) {
      u.uCutEnabled.value = 0;
      return;
    }
    playerCenter.set(localPlayer.x, world.playerSize / 2, localPlayer.z);
    projected.copy(playerCenter).project(camera);
    gl.getDrawingBufferSize(buffer);
    right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const radiusPx = screenRadius(camera, cfg.radius, buffer.x, buffer.y);
    const innerPx = screenRadius(
      camera,
      Math.max(0, cfg.radius - cfg.softness),
      buffer.x,
      buffer.y,
    );
    u.uCutEnabled.value = projected.z < 1 ? 1 : 0;
    u.uCutPlayer.value.copy(playerCenter);
    u.uCutScreen.value.set(((projected.x + 1) / 2) * buffer.x, ((projected.y + 1) / 2) * buffer.y);
    u.uCutRadiusPx.value = radiusPx;
    u.uCutSoftPx.value = Math.max(1, radiusPx - innerPx);
  });
  return null;
}

/** Images rendues avec toute l'île visible au montage : géométries envoyées au GPU d'avance. */
const WARMUP_FRAMES = 2;

/**
 * L'île : 2 géométries fusionnées (murs + lumières) par area, seules l'area du joueur et ses
 * voisines directes sont dessinées (la mer toujours) ; décor instancié filtré de même.
 * `lockVersion` : reconstruction quand le verrou d'une area change (portail de l'aéroport).
 */
export function City({
  glowBoost,
  lockVersion,
  themeId,
  shadows,
  outlines = false,
  wind = false,
}: {
  glowBoost: number;
  /** Contour des bâtiments de l'area du joueur (qualité et thème le permettent). */
  outlines?: boolean;
  /** Vent des touffes d'herbe (coupé en qualité basse). */
  wind?: boolean;
  lockVersion: number;
  themeId: ThemeId;
  /** Ombre temps réel (qualité haute, hors tactile) : les murs la portent et la reçoivent. */
  shadows: boolean;
}) {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- lockVersion : gameData muté en place
  const data = useMemo(() => themedData(gameData, themeId), [themeId, lockVersion]);
  const geometry = useMemo(
    () => buildCity(data, themeOf(gameData.config, themeId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- data suit déjà themeId
    [data],
  );
  const propKits = useMemo(() => propKitItems(data), [data]);
  const mergedProps = useMemo(() => mergedPropIds(data), [data]);
  // thème doux (neutre) : halos des devantures et des lampadaires coupés
  const { halos, glow, shading, outline, panels, propTint, grass } = themeOf(
    gameData.config,
    themeId,
  );
  // thème jour : fenêtres, enseignes, guirlandes et lueurs en matériau éclairé (panneaux peints)
  const painted = glow === 'painted';
  const loaded = useLoadedAreas();
  const [warm, setWarm] = useState(false);
  const frames = useRef(0);
  useFrame(() => {
    if (!warm && ++frames.current > WARMUP_FRAMES) setWarm(true);
  });
  // Bâtiments : découpe devant le joueur. Décor (bas) : matériaux sans découpe.
  const materials = useMemo(
    () => ({
      solid: applyCutout(shadedMaterial({ vertexColors: true }, shading)),
      glow: applyCutout(
        painted
          ? shadedMaterial({ vertexColors: true }, shading)
          : new MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
      ),
      decorSolid: shadedMaterial({ vertexColors: true }, shading),
      decorGlow: painted
        ? shadedMaterial({ vertexColors: true }, shading)
        : new MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    }),
    [painted, shading],
  );

  // décor importé : un matériau par atlas de pack (couleurs d'origine) et par découpe
  // (bâtiments percés devant le joueur comme les façades générées)
  const propMaterials = useMemo(() => {
    const cache = new Map<string, Material>();
    const make = (texture: Texture | null, cut: boolean, emit: boolean): Material => {
      const key = `${texture?.uuid ?? 'sommets'}|${cut}|${emit}`;
      let m = cache.get(key);
      if (!m) {
        const base = shadedMaterial({ vertexColors: true, map: texture }, shading);
        m = cut ? applyCutout(base) : base;
        // néons des modèles (props.json emissive) dans le même draw call
        if (emit) m = applyEmission(m, gameData.propsEmissive.strength);
        cache.set(key, m);
      }
      return m;
    };
    return { cache, make };
  }, [shading]);
  useEffect(
    () => () => {
      for (const m of propMaterials.cache.values()) m.dispose();
    },
    [propMaterials],
  );

  // contour (coque inversée) : bâtiments de l'area du joueur seulement (+1 draw call)
  const outlineMat = useMemo(
    () => (outline ? outlineMaterial(outline.width, outline.color) : null),
    [outline],
  );
  useEffect(() => () => outlineMat?.dispose(), [outlineMat]);
  const here = loaded.size > 0 ? currentArea() : '';
  const outlined = outlines && outlineMat && warm ? geometry.get(here)?.solid : undefined;

  // En qualité moyen/haut, les émissifs passent au-dessus de 1 pour déclencher le bloom.
  useEffect(() => {
    (materials.glow as MeshBasicMaterial).color.setScalar(glowBoost);
    (materials.decorGlow as MeshBasicMaterial).color.setScalar(glowBoost);
  }, [materials, glowBoost]);

  useEffect(
    () => () => {
      for (const g of geometry.values()) {
        g.solid?.dispose();
        g.glow?.dispose();
      }
    },
    [geometry],
  );
  useEffect(
    () => () => {
      for (const m of Object.values(materials)) m.dispose();
    },
    [materials],
  );

  return (
    <>
      {[...geometry].map(([key, g]) => {
        const visible = !warm || key === SEA_GROUP || loaded.has(key);
        return (
          <group key={key} visible={visible}>
            {g.solid && (
              <mesh
                geometry={g.solid}
                material={materials.solid}
                castShadow={shadows}
                receiveShadow={shadows}
              />
            )}
            {g.glow && <mesh geometry={g.glow} material={materials.glow} />}
          </group>
        );
      })}
      {outlined && outlineMat && <mesh geometry={outlined} material={outlineMat} />}
      <Decor
        loaded={warm ? loaded : null}
        halos={halos}
        data={data}
        solidMaterial={materials.decorSolid}
        glowMaterial={materials.decorGlow}
      />
      <PropKits
        kits={propKits}
        merged={mergedProps}
        loaded={warm ? loaded : null}
        data={data}
        materialFor={propMaterials.make}
        propTint={propTint}
      />
      {grass && (
        <GrassTufts
          data={data}
          grass={grass}
          shading={shading}
          loaded={warm ? loaded : null}
          wind={wind}
        />
      )}
      {panels && <Panels data={data} loaded={warm ? loaded : null} />}
      {halos && <Halos data={data} loaded={warm ? loaded : null} glowBoost={glowBoost} />}
      <CutoutDriver />
    </>
  );
}
