import {
  BackSide,
  DataTexture,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshToonMaterial,
  NearestFilter,
  RGBAFormat,
  type Material,
  type MeshLambertMaterialParameters,
  type MeshToonMaterialParameters,
} from 'three';

/**
 * Seule fabrique de matériaux éclairés du jeu : rendu low-poly à facettes (`flatShading`, normale
 * par face calculée dans le shader), aucun coût en draw call. Les matériaux non éclairés
 * (`MeshBasicMaterial` : néons, halos, anneaux) n'ont pas d'ombrage.
 */
export function litMaterial(params: MeshLambertMaterialParameters = {}): MeshLambertMaterial {
  return new MeshLambertMaterial({ ...params, flatShading: true });
}

/** Copie d'un matériau importé (glTF), passée en facettes s'il est éclairé. */
export function facetedClone(source: Material): Material {
  const m = source.clone();
  if ('flatShading' in m) {
    m.flatShading = true;
    m.needsUpdate = true;
  }
  return m;
}

/** Ombrage d'un thème (`config.theme.<id>.shading`). */
export interface Shading {
  mode: 'lambert' | 'toon';
  steps: readonly number[];
}

const gradients = new Map<string, DataTexture>();

/**
 * Dégradé du toon généré en code : un texel par palier (luminosité `steps`), filtrage au plus
 * proche pour des paliers francs. Partagé par clé de paliers.
 */
export function toonGradient(steps: readonly number[]): DataTexture {
  const key = steps.join(',');
  let tex = gradients.get(key);
  if (!tex) {
    const data = new Uint8Array(steps.length * 4);
    steps.forEach((s, i) => data.set([s * 255, s * 255, s * 255, 255], i * 4));
    tex = new DataTexture(data, steps.length, 1, RGBAFormat);
    tex.minFilter = tex.magFilter = NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    gradients.set(key, tex);
  }
  return tex;
}

/**
 * Matériau éclairé selon l'ombrage du thème : Lambert à facettes, ou toon à paliers (bâtiments,
 * props, véhicules du thème jour). Même coût en draw calls.
 */
export function shadedMaterial(
  params: MeshLambertMaterialParameters & MeshToonMaterialParameters = {},
  shading: Shading = { mode: 'lambert', steps: [] },
): Material {
  if (shading.mode === 'lambert') return litMaterial(params);
  const m = new MeshToonMaterial({ ...params, gradientMap: toonGradient(shading.steps) });
  (m as unknown as { flatShading: boolean }).flatShading = true;
  return m;
}

/**
 * Contour « coque inversée » : faces arrière seules, sommets poussés le long de leur normale
 * (`width`, m), couleur unie. Un draw call de plus par géométrie contournée.
 */
export function outlineMaterial(width: number, color: string): MeshBasicMaterial {
  const m = new MeshBasicMaterial({ color, side: BackSide });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uOutline = { value: width };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uOutline;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\ntransformed += normalize(normal) * uOutline;',
      );
  };
  m.customProgramCacheKey = () => 'narco-outline';
  return m;
}
