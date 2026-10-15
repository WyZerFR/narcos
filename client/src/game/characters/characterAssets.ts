import { useEffect, useState } from 'react';
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  MeshLambertMaterial,
  SkinnedMesh,
  Vector4,
  type AnimationClip,
  type Material,
  type Object3D,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { gameData, slotColors, type Appearance, type Character } from '@narco/shared';

/**
 * Modèles des personnages (`characters.json`) : chargés une seule fois par id, à la demande
 * (écran de sélection ou premier joueur qui l'utilise). Les primitives d'un même squelette
 * (une par matériau dans le fichier) sont fusionnées en une seule SkinnedMesh à couleurs de
 * sommets : un draw call par personnage au lieu de 5 à 18.
 */

export interface CharacterAsset {
  character: Character;
  /** Modèle prêt (normalisé à `height`, rotation corrective appliquée) : à cloner. */
  template: Group;
  clips: AnimationClip[];
  triangles: number;
  drawCalls: number;
}

type Entry =
  | { status: 'loading'; promise: Promise<CharacterAsset> }
  | { status: 'ready'; asset: CharacterAsset }
  | { status: 'error' };

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
const loader = new GLTFLoader();
const DEG = Math.PI / 180;

function emit(): void {
  for (const fn of listeners) fn();
}

/** Attributs gardés : la fusion exige les mêmes partout (pas d'UV, aucun modèle texturé). */
const KEEP = ['position', 'normal', 'skinIndex', 'skinWeight'];

type ColoredMaterial = Material & { color?: Color };

function materialOf(mesh: SkinnedMesh): ColoredMaterial | undefined {
  return (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
    ColoredMaterial | undefined;
}

const luminance = (c: Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/**
 * Slot de chaque part (rang dans palettes.json, 0 = couleur d'origine) d'après le nom de son
 * matériau, et nuance relative dans son slot : luminance d'origine / plus claire du slot, pour
 * garder les écarts de ton (cheveux / sourcils, peau / peau foncée) une fois recolorés.
 */
function slotShades(character: Character, list: SkinnedMesh[]): [number, number][] {
  const slotByMaterial = new Map<string, number>();
  for (const [slot, names] of Object.entries(character.slots)) {
    const index = gameData.appearanceSlots.get(slot)?.index ?? 0;
    for (const n of names) slotByMaterial.set(n, index);
  }
  const parts = list.map((m) => {
    const mat = materialOf(m);
    return {
      slot: slotByMaterial.get(mat?.name ?? '') ?? 0,
      lum: mat?.color ? luminance(mat.color) : 1,
    };
  });
  const brightest = new Map<number, number>();
  for (const p of parts) brightest.set(p.slot, Math.max(brightest.get(p.slot) ?? 0, p.lum));
  return parts.map((p) => [p.slot, p.slot ? Math.min(1, p.lum / (brightest.get(p.slot) || 1)) : 1]);
}

/** Géométrie d'une primitive + couleur de son matériau, slot et nuance en attributs de sommet. */
function colored(mesh: SkinnedMesh, [slot, shade]: [number, number]): BufferGeometry | null {
  const src = mesh.geometry;
  if (!KEEP.every((k) => src.getAttribute(k))) return null;
  // attributs recopiés à plat (ni entrelacés ni normalisés) : mêmes types pour toutes les parts
  const geo = new BufferGeometry();
  for (const name of KEEP) {
    const a = src.getAttribute(name);
    const out =
      name === 'skinIndex'
        ? new Uint16Array(a.count * a.itemSize)
        : new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++)
      for (let j = 0; j < a.itemSize; j++) out[i * a.itemSize + j] = a.getComponent(i, j);
    geo.setAttribute(name, new BufferAttribute(out, a.itemSize));
  }
  if (src.index) geo.setIndex(Array.from(src.index.array));
  const c = materialOf(mesh)?.color ?? { r: 1, g: 1, b: 1 };
  const count = geo.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  const slots = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    colors.set([c.r, c.g, c.b], i * 3);
    slots.set([slot, shade], i * 2);
  }
  geo.setAttribute('color', new BufferAttribute(colors, 3));
  geo.setAttribute('slotShade', new BufferAttribute(slots, 2));
  return geo;
}

const SLOT_COUNT = gameData.appearanceSlots.size + 1;

/**
 * Matériau du corps fusionné : couleurs de sommets, sauf pour les slots recolorés où la teinte
 * de la palette (uniform par slot, w = 1 si active) × la nuance d'origine les remplace. Un seul
 * programme partagé, un seul draw call ; l'éclairage Lambert garde l'ombrage du modèle.
 */
export function characterMaterial(): MeshLambertMaterial {
  const mat = new MeshLambertMaterial({ vertexColors: true });
  const slotColors = Array.from({ length: SLOT_COUNT }, () => new Vector4(0, 0, 0, 0));
  mat.userData.slotColors = slotColors;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.slotColors = { value: slotColors };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\nattribute vec2 slotShade;\nuniform vec4 slotColors[${SLOT_COUNT}];`,
      )
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
  vec4 slotTint = slotColors[int(slotShade.x + 0.5)];
  vColor.rgb = mix(vColor.rgb, slotTint.rgb * slotShade.y, slotTint.w);`,
      );
  };
  mat.customProgramCacheKey = () => `narco-character-${SLOT_COUNT}`;
  return mat;
}

/** Couleurs du joueur sur une instance (slot absent = couleur d'origine). */
export function applyAppearance(root: Object3D, appearance: Appearance): void {
  const colors = slotColors(gameData, appearance);
  for (const m of materialsOf(root)) {
    const uniforms = m.userData.slotColors as Vector4[] | undefined;
    uniforms?.forEach((u, i) => {
      const hex = colors[i];
      if (hex) {
        const c = new Color(hex);
        u.set(c.r, c.g, c.b, 1);
      } else u.set(0, 0, 0, 0);
    });
  }
}

/** Fusionne les SkinnedMesh qui partagent squelette et matrice de liaison. */
function mergeSkinned(root: Object3D, character: Character): void {
  const meshes: SkinnedMesh[] = [];
  root.traverse((o) => {
    if ((o as SkinnedMesh).isSkinnedMesh) meshes.push(o as SkinnedMesh);
  });
  const groups = new Map<string, SkinnedMesh[]>();
  for (const m of meshes) {
    // un squelette par nœud dans GLTFLoader, mais les mêmes os : on regroupe par os
    const key = m.skeleton.bones.map((b) => b.uuid).join('|');
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  for (const list of groups.values()) {
    // une seule part aussi : le matériau à slots doit être le même pour tous les modèles
    const shades = slotShades(character, list);
    const geos = list.map((m, i) => colored(m, shades[i]!));
    if (geos.some((g) => !g)) continue;
    // Chaque part ramenée dans l'espace de liaison de la première (v' = B0⁻¹ · Bm · v) :
    // en mode « attached », le sommet skinné vaut Σ w · os · Bm · v, donc rendu identique.
    const inv0 = list[0]!.bindMatrix.clone().invert();
    list.forEach((m, i) => geos[i]!.applyMatrix4(inv0.clone().multiply(m.bindMatrix)));
    const indexed = geos.every((g) => g!.index);
    const merged = mergeGeometries(
      geos.map((g) => (indexed ? g! : g!.index ? g!.toNonIndexed() : g!)),
      false,
    );
    if (!merged) continue;
    const first = list[0]!;
    const mesh = new SkinnedMesh(merged, characterMaterial());
    mesh.name = 'character';
    mesh.position.copy(first.position);
    mesh.quaternion.copy(first.quaternion);
    mesh.scale.copy(first.scale);
    mesh.bind(first.skeleton, first.bindMatrix);
    first.parent!.add(mesh);
    for (const m of list) {
      m.removeFromParent();
      m.geometry.dispose();
    }
  }
}

export function prepare(
  character: Character,
  scene: Group,
): Omit<CharacterAsset, 'clips' | 'character'> {
  mergeSkinned(scene, character);
  let triangles = 0;
  let drawCalls = 0;
  scene.traverse((o) => {
    const mesh = o as SkinnedMesh;
    if (!mesh.isMesh) return;
    drawCalls++;
    const g = mesh.geometry;
    triangles += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    mesh.frustumCulled = false; // boîte englobante de la pose de liaison : fausse en mouvement
  });
  // normalisation : pieds au sol, hauteur de characters.json × échelle
  const inner = new Group();
  inner.add(scene);
  inner.rotation.y = character.rotationY * DEG;
  scene.updateMatrixWorld(true);
  const box = new Box3().setFromObject(scene, true);
  const h = Math.max(1e-3, box.max.y - box.min.y);
  const k = (character.height / h) * character.scale;
  scene.scale.multiplyScalar(k);
  scene.position.y -= box.min.y * k;
  const template = new Group();
  template.add(inner);
  return { template, triangles: Math.round(triangles), drawCalls };
}

let library: Promise<AnimationClip[]> | null = null;

/**
 * Clips communs (`config.characters.animations.library`), chargés une seule fois : tous les
 * skins partagent le squelette, les pistes se lient par nom d'os. Échec = aucun clip (repli).
 */
function libraryClips(): Promise<AnimationClip[]> {
  library ??= loader
    .loadAsync(`${import.meta.env.BASE_URL}${gameData.config.characters.animations.library}`)
    .then((g) => g.animations)
    .catch((err: unknown) => {
      console.warn('[narco] animations communes non chargées', err);
      return [];
    });
  return library;
}

/** Clips d'un skin : les siens s'il en a, sinon ceux de la bibliothèque commune. */
export function clipsFor(own: AnimationClip[], shared: AnimationClip[]): AnimationClip[] {
  return own.length ? own : shared;
}

/** Charge (une fois) le modèle d'un personnage. */
export function loadCharacter(id: string): Promise<CharacterAsset> {
  const hit = cache.get(id);
  if (hit?.status === 'ready') return Promise.resolve(hit.asset);
  if (hit?.status === 'loading') return hit.promise;
  const character = gameData.characters.get(id);
  if (!character) return Promise.reject(new Error(`personnage inconnu : ${id}`));
  const url = `${import.meta.env.BASE_URL}${character.model}`;
  const promise = Promise.all([loader.loadAsync(url), libraryClips()]).then(([gltf, shared]) => {
    const asset: CharacterAsset = {
      character,
      clips: clipsFor(gltf.animations, shared),
      ...prepare(character, gltf.scene),
    };
    cache.set(id, { status: 'ready', asset });
    emit();
    return asset;
  });
  promise.catch((err: unknown) => {
    console.warn(`[narco] modèle ${id} non chargé, repli sur le cube`, err);
    cache.set(id, { status: 'error' });
    emit();
  });
  cache.set(id, { status: 'loading', promise });
  emit();
  return promise;
}

/** État du modèle d'un personnage (déclenche le chargement paresseux). */
export function useCharacterAsset(id: string): CharacterAsset | 'loading' | 'error' {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    listeners.add(fn);
    void loadCharacter(id).catch(() => undefined);
    return () => {
      listeners.delete(fn);
    };
  }, [id]);
  const entry = cache.get(id);
  if (entry?.status === 'ready') return entry.asset;
  if (entry?.status === 'error' || !gameData.characters.has(id)) return 'error';
  return 'loading';
}

/**
 * Instance indépendante (squelette cloné, matériaux propres : transparence et couleurs par
 * joueur ; `clone()` ne recopie pas le patch du shader, d'où un matériau neuf pour le corps).
 */
export function instantiate(asset: Pick<CharacterAsset, 'template'>): Group {
  const root = cloneSkinned(asset.template) as Group;
  root.traverse((o) => {
    const mesh = o as SkinnedMesh;
    if (!mesh.isMesh) return;
    const source = mesh.material as Material;
    mesh.material = source.userData.slotColors ? characterMaterial() : source.clone();
  });
  return root;
}

function materialsOf(root: Object3D): Material[] {
  const list: Material[] = [];
  root.traverse((o) => {
    const m = (o as { material?: Material }).material;
    if (m) list.push(m);
  });
  return list;
}

/** Transparence « fantôme » (joueur déconnecté) ; couleur et émissif du modèle intacts. */
export function applyBodyState(root: Object3D, ghost: boolean): void {
  for (const m of materialsOf(root)) {
    m.transparent = ghost;
    m.opacity = ghost ? 0.35 : 1;
    m.needsUpdate = true;
  }
}

export function disposeMaterials(root: Object3D): void {
  for (const m of materialsOf(root)) m.dispose();
}
