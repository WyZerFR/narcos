import { useLayoutEffect, useMemo, useRef } from 'react';
import {
  BufferAttribute,
  CanvasTexture,
  Euler,
  InstancedBufferAttribute,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type InstancedMesh,
} from 'three';
import { footprint, hasFacade, visibleLocations, type GameData, type Rect } from '@narco/shared';
import { faceOf } from './batch';
import { sideTowardRoad } from './buildCity';
import { blockModelHeights } from './propPlacements';
import { areaIdNear } from '../areaStreaming';
import { applyCutout } from './cutout';

/** Un panneau peint : texte, centre, orientation (normale de la façade), taille, fond. */
export interface PanelSpot {
  text: string;
  x: number;
  y: number;
  z: number;
  rotY: number;
  w: number;
  h: number;
  color: string;
}

/** Proportions d'un panneau : hauteur (m), largeur par caractère, saillie hors façade. */
const PANEL_H = 1.3;
const PER_CHAR = 0.62;
const PROUD = 0.25;
/** Atlas : une ligne de texte par panneau. */
const ROW_W = 1024;
const ROW_H = 128;

/**
 * Panneaux peints des façades à enseigne (`panel` des lieux et blocs) : sur la façade de la
 * porte (sinon celle tournée vers la route), aux deux tiers de la hauteur réelle (modèle importé
 * compris), largeur selon le texte, bornée par la façade.
 */
export function panelSpots(data: GameData): PanelSpot[] {
  const heights = blockModelHeights(data);
  const spot = (
    text: string,
    r: Rect,
    side: Parameters<typeof faceOf>[1],
    height: number,
    color: string,
  ): PanelSpot => {
    const f = faceOf(r, side);
    return {
      text,
      x: f.cx + f.nx * PROUD,
      z: f.cz + f.nz * PROUD,
      y: Math.max(PANEL_H, Math.min(height * 0.66, height - PANEL_H)),
      rotY: Math.atan2(f.nx, f.nz),
      w: Math.min(f.len * 0.85, 1 + text.length * PER_CHAR),
      h: PANEL_H,
      color,
    };
  };
  const { palette } = data.config;
  return [
    ...visibleLocations(data.locations.values()).flatMap((l) => {
      // une façade importée porte sa propre enseigne
      if (!l.panel || hasFacade(data, l.id)) return [];
      const r = footprint(l);
      return [spot(l.panel, r, l.door ?? sideTowardRoad(data, r), l.height, l.neonColor)];
    }),
    ...data.blocks.flatMap((b) => {
      if (!b.panel || hasFacade(data, b.id)) return [];
      const r = footprint(b);
      const height = heights.get(b.id) ?? b.height;
      return [
        spot(b.panel, r, b.door ?? sideTowardRoad(data, r), height, b.neonColor ?? palette.wall),
      ];
    }),
  ];
}

/** Largeur (px) de la ligne d'atlas d'un panneau : même rapport que le panneau, texte non étiré. */
const rowWidth = (s: PanelSpot) => Math.min(ROW_W, Math.round((ROW_H * s.w) / s.h));

/** Atlas des textes (canvas 2D) : fond à la couleur du lieu, liseré, texte sombre centré. */
function atlas(spots: PanelSpot[], ink: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = ROW_W;
  canvas.height = Math.max(ROW_H, 2 ** Math.ceil(Math.log2(spots.length * ROW_H)));
  const ctx = canvas.getContext('2d');
  // sous Node (tests), le canvas est factice : rien à dessiner
  if (ctx && typeof ctx.fillText === 'function')
    spots.forEach((s, i) => {
      const y = i * ROW_H;
      const w = rowWidth(s);
      ctx.fillStyle = ink;
      ctx.fillRect(0, y, w, ROW_H);
      ctx.fillStyle = s.color;
      ctx.fillRect(8, y + 8, w - 16, ROW_H - 16);
      ctx.fillStyle = ink;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let px = 82;
      ctx.font = `900 ${px}px sans-serif`;
      while (px > 30 && ctx.measureText(s.text).width > w - 48) {
        px -= 4;
        ctx.font = `900 ${px}px sans-serif`;
      }
      ctx.fillText(s.text, w / 2, y + ROW_H / 2 + 4);
    });
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const tmpM = new Matrix4();
const tmpQ = new Quaternion();
const tmpE = new Euler();
const tmpP = new Vector3();
const tmpS = new Vector3();

/**
 * Tous les panneaux peints en un draw call : quad instancié, rectangle d'atlas par instance
 * (`aUvRect`), percé par la découpe devant le joueur comme les façades.
 */
export function Panels({ data, loaded }: { data: GameData; loaded: ReadonlySet<string> | null }) {
  const ref = useRef<InstancedMesh>(null);
  const spots = useMemo(() => panelSpots(data), [data]);
  const areas = useMemo(() => spots.map((s) => areaIdNear(s)), [spots]);
  const { geometry, material, rects } = useMemo(() => {
    const g = new PlaneGeometry(1, 1);
    g.setAttribute('aCut', new BufferAttribute(new Float32Array(4).fill(1), 1));
    const rects = new Float32Array(spots.length * 4);
    const rows =
      Math.max(ROW_H, 2 ** Math.ceil(Math.log2(Math.max(1, spots.length) * ROW_H))) / ROW_H;
    spots.forEach((s, i) =>
      rects.set([0, 1 - (i + 1) / rows, rowWidth(s) / ROW_W, 1 / rows], i * 4),
    );
    g.setAttribute('aUvRect', new InstancedBufferAttribute(rects.slice(), 4));
    const m = applyCutout(new MeshBasicMaterial({ map: atlas(spots, data.config.palette.street) }));
    const cutout = m.onBeforeCompile;
    m.onBeforeCompile = (shader, renderer) => {
      cutout(shader, renderer);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aUvRect;')
        .replace(
          '#include <uv_vertex>',
          '#include <uv_vertex>\nvMapUv = aUvRect.xy + uv * aUvRect.zw;',
        );
    };
    m.customProgramCacheKey = () => 'narco-panels';
    return { geometry: g, material: m, rects };
  }, [spots, data]);
  useLayoutEffect(
    () => () => {
      geometry.dispose();
      material.map?.dispose();
      material.dispose();
    },
    [geometry, material],
  );
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const rect = geometry.getAttribute('aUvRect') as InstancedBufferAttribute;
    let n = 0;
    spots.forEach((s, i) => {
      if (loaded && !loaded.has(areas[i]!)) return;
      tmpQ.setFromEuler(tmpE.set(0, s.rotY, 0));
      mesh.setMatrixAt(n, tmpM.compose(tmpP.set(s.x, s.y, s.z), tmpQ, tmpS.set(s.w, s.h, 1)));
      (rect.array as Float32Array).set(rects.subarray(i * 4, i * 4 + 4), n * 4);
      n++;
    });
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    rect.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [spots, areas, loaded, geometry, rects]);
  if (spots.length === 0) return null;
  return (
    <instancedMesh ref={ref} args={[geometry, material, spots.length]} frustumCulled={false} />
  );
}
