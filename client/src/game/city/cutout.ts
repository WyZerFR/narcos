import { useSyncExternalStore } from 'react';
import { Vector2, Vector3, type Material } from 'three';
import { gameData, type CutoutConfig } from '@narco/shared';

/**
 * Découpe des façades : les fragments de bâtiment situés entre la caméra et le joueur local,
 * dans un disque autour du joueur projeté à l'écran, sont éliminés (bord tramé). Aucun
 * draw call en plus : c'est le shader des deux matériaux fusionnés qui fait le travail.
 */

// ---------------------------------------------------------------- réglages en direct

let current: CutoutConfig = { ...gameData.config.cutout };
const listeners = new Set<() => void>();

export const getCutout = (): CutoutConfig => current;

export function updateCutout(patch: Partial<CutoutConfig>): void {
  current = { ...current, ...patch };
  for (const fn of listeners) fn();
}

export function resetCutout(): void {
  updateCutout({ ...gameData.config.cutout });
}

export function useCutout(): CutoutConfig {
  return useSyncExternalStore((fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, getCutout);
}

// ---------------------------------------------------------------- uniforms partagés

/** Mis à jour à chaque frame par `CutoutDriver` ; les mêmes objets sont branchés dans les shaders. */
export const cutoutUniforms = {
  uCutEnabled: { value: 0 },
  /** Centre du joueur local (monde). */
  uCutPlayer: { value: new Vector3() },
  /** Joueur projeté, en pixels du tampon de rendu (origine en bas à gauche, comme gl_FragCoord). */
  uCutScreen: { value: new Vector2() },
  uCutRadiusPx: { value: 0 },
  uCutSoftPx: { value: 0 },
  /** Marge de profondeur : seules les surfaces nettement devant le joueur sont percées. */
  uCutDepthMargin: { value: gameData.config.world.playerSize / 2 },
};

const VERTEX_DECL = /* glsl */ `
attribute float aCut;
varying float vCut;
varying vec3 vCutWorld;
`;

const VERTEX_BODY = /* glsl */ `
vCut = aCut;
vCutWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

const FRAGMENT_DECL = /* glsl */ `
uniform float uCutEnabled;
uniform vec3 uCutPlayer;
uniform vec2 uCutScreen;
uniform float uCutRadiusPx;
uniform float uCutSoftPx;
uniform float uCutDepthMargin;
varying float vCut;
varying vec3 vCutWorld;

// Matrice de Bayer 4x4 : seuil de trame stable à l'écran pour le bord du trou.
float cutBayer4(vec2 p) {
  ivec2 c = ivec2(mod(p, 4.0));
  int i = c.x + c.y * 4;
  float m[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
  return (m[i] + 0.5) / 16.0;
}
`;

const FRAGMENT_BODY = /* glsl */ `
if (uCutEnabled > 0.5 && vCut > 0.5) {
  float cutPlayerDist = distance(cameraPosition, uCutPlayer);
  float cutFragDist = distance(cameraPosition, vCutWorld);
  if (cutFragDist < cutPlayerDist - uCutDepthMargin) {
    float cutPx = distance(gl_FragCoord.xy, uCutScreen);
    float cutKeep = smoothstep(uCutRadiusPx - uCutSoftPx, uCutRadiusPx, cutPx);
    if (cutKeep < cutBayer4(gl_FragCoord.xy)) discard;
  }
}
`;

/** Branche la découpe sur un matériau dont la géométrie porte l'attribut `aCut`. */
export function applyCutout<M extends Material>(material: M): M {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, cutoutUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_DECL}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_DECL}`)
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>\n${FRAGMENT_BODY}`,
      );
  };
  material.customProgramCacheKey = () => 'narco-cutout';
  return material;
}
