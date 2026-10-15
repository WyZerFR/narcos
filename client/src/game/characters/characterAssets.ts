import { useEffect, useState } from 'react';
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Group,
  MeshLambertMaterial,
  SkinnedMesh,
  type AnimationClip,
  type Material,
  type Object3D,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { gameData, type Character } from '@narco/shared';

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

/** Géométrie d'une primitive + couleur de son matériau en attribut de sommet. */
function colored(mesh: SkinnedMesh): BufferGeometry | null {
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
  const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
    (Material & { color?: { r: number; g: number; b: number } }) | undefined;
  const c = mat?.color ?? { r: 1, g: 1, b: 1 };
  const count = geo.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colors.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new BufferAttribute(colors, 3));
  return geo;
}

/** Fusionne les SkinnedMesh qui partagent squelette et matrice de liaison. */
function mergeSkinned(root: Object3D): void {
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
    if (list.length < 2) continue;
    const geos = list.map(colored);
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
    const mesh = new SkinnedMesh(merged, new MeshLambertMaterial({ vertexColors: true }));
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
  mergeSkinned(scene);
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

/** Charge (une fois) le modèle d'un personnage. */
export function loadCharacter(id: string): Promise<CharacterAsset> {
  const hit = cache.get(id);
  if (hit?.status === 'ready') return Promise.resolve(hit.asset);
  if (hit?.status === 'loading') return hit.promise;
  const character = gameData.characters.get(id);
  if (!character) return Promise.reject(new Error(`personnage inconnu : ${id}`));
  const url = `${import.meta.env.BASE_URL}${character.model}`;
  const promise = loader.loadAsync(url).then((gltf) => {
    const asset: CharacterAsset = {
      character,
      clips: gltf.animations,
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

/** Instance indépendante (squelette cloné, matériaux propres pour la transparence). */
export function instantiate(asset: CharacterAsset): Group {
  const root = cloneSkinned(asset.template) as Group;
  root.traverse((o) => {
    const mesh = o as SkinnedMesh;
    if (mesh.isMesh) mesh.material = (mesh.material as Material).clone();
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
