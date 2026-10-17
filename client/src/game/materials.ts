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
 * Néons d'un modèle importé dans le même draw call : les faces dont l'attribut `aEmit` vaut 1
 * émettent leur couleur × `strength` (`props.json` emissive). S'enchaîne avec un
 * `onBeforeCompile` déjà posé (découpe).
 */
export function applyEmission<M extends Material>(material: M, strength: number): M {
  const previous = material.onBeforeCompile.bind(material);
  const previousKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    shader.uniforms.uEmitStrength = { value: strength };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float aEmit;\nvarying float vEmit;',
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEmit = aEmit;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uEmitStrength;\nvarying float vEmit;',
      )
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vEmit * uEmitStrength;',
      );
  };
  material.customProgramCacheKey = () => `${previousKey()}|narco-emit`;
  return material;
}

/**
 * Carrosserie teinte par instance dans le même draw call : les sommets dont l'attribut `aPaint`
 * vaut 1 (blancs à l'import) prennent la couleur d'instance (`InstancedMesh.setColorAt`), les
 * autres (vitres, pneus, phares) gardent leur couleur. S'enchaîne avec un `onBeforeCompile`.
 */
export function applyPaint<M extends Material>(material: M): M {
  const previous = material.onBeforeCompile.bind(material);
  const previousKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aPaint;')
      .replace(
        '#include <color_vertex>',
        '#include <color_vertex>\n#if defined( USE_COLOR ) && defined( USE_INSTANCING_COLOR )\nvColor.xyz = color.xyz * mix( vec3( 1.0 ), instanceColor.xyz, aPaint );\n#endif',
      );
  };
  material.customProgramCacheKey = () => `${previousKey()}|narco-paint`;
  return material;
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
