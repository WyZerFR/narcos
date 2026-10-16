import { useEffect, useSyncExternalStore } from 'react';
import {
  BoxGeometry,
  NearestFilter,
  NearestMipmapLinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
  TextureLoader,
  type Texture,
  BufferAttribute,
  Color,
  type BufferGeometry,
  type Mesh,
  type Object3D,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { gameData, type GameConfig, type Prop } from '@narco/shared';
import { shade } from './batch';

/**
 * Décor 3D importé (`props.json`) : chargé une fois par id, à la demande (area chargée),
 * géométrie normalisée : pied centré à l'origine, avant vers +Z, hauteur réelle en mètres,
 * couleurs de sommets (rgb) et attribut `aCut` (1 = percé par la découpe : bâtiments).
 * Un modèle en échec est journalisé et remplacé par un cube neutre de la même emprise.
 */
export type PropEntry =
  | { status: 'loading' }
  | { status: 'ready'; geometry: BufferGeometry; texture: Texture | null }
  | { status: 'error' };

const cache = new Map<string, PropEntry>();
const listeners = new Set<() => void>();
const loader = new GLTFLoader();

/** Lecture d'un fichier de `client/public` (remplacée sous Node par les tests). */
let readModel = async (path: string): Promise<ArrayBuffer> => {
  const res = await fetch(`${import.meta.env.BASE_URL}${path}`);
  if (!res.ok) throw new Error(`${path} : HTTP ${res.status}`);
  return res.arrayBuffer();
};

export function setPropReader(reader: (path: string) => Promise<ArrayBuffer>): void {
  readModel = reader;
}

/** Tests : vide le cache. */
export function resetPropCache(): void {
  for (const e of cache.values()) if (e.status === 'ready') e.geometry.dispose();
  cache.clear();
  for (const fn of listeners) fn();
}

function set(id: string, entry: PropEntry) {
  cache.set(id, entry);
  for (const fn of listeners) fn();
}

/** Géométrie du premier maillage, dans le repère normalisé du prop. */
export function normalizeProp(root: Object3D, prop: Prop): BufferGeometry {
  root.updateMatrixWorld(true);
  let mesh: Mesh | null = null;
  root.traverse((o) => {
    if (!mesh && (o as Mesh).isMesh) mesh = o as Mesh;
  });
  if (!mesh) throw new Error(`${prop.model} : aucun maillage`);
  const found = mesh as Mesh;
  const src = found.geometry.clone().applyMatrix4(found.matrixWorld);
  const g = src.index ? src.toNonIndexed() : src;
  if (g !== src) src.dispose();
  const [ox, oy, oz] = prop.offset;
  const s = prop.height / (prop.bounds.max[1] - prop.bounds.min[1]);
  g.translate(ox, oy, oz)
    .rotateY((prop.rotationY * Math.PI) / 180)
    .scale(s, s, s);
  // couleurs rgb flottantes (le GLB les porte en octets normalisés rgba)
  const count = g.attributes.position!.count;
  const rgb = new Float32Array(count * 3).fill(1);
  const color = g.attributes.color;
  if (color)
    for (let i = 0; i < count; i++) rgb.set([color.getX(i), color.getY(i), color.getZ(i)], i * 3);
  g.setAttribute('color', new BufferAttribute(rgb, 3));
  g.setAttribute(
    'aCut',
    new BufferAttribute(new Float32Array(count).fill(prop.cuttable ? 1 : 0), 1),
  );
  for (const name of Object.keys(g.attributes))
    if (!['position', 'color', 'aCut', 'uv'].includes(name)) g.deleteAttribute(name);
  g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}

/** Lance le chargement d'un prop (une seule fois par id). */
export function requestProp(id: string): void {
  if (cache.has(id)) return;
  const prop = gameData.props.get(id);
  if (!prop) {
    console.warn(`[narco] prop inconnu "${id}", repli sur le cube`);
    set(id, { status: 'error' });
    return;
  }
  set(id, { status: 'loading' });
  Promise.all([
    readModel(prop.model).then((buf) => loader.parseAsync(buf, '')),
    prop.texture ? loadPropTexture(prop.texture) : null,
  ])
    .then(([gltf, texture]) =>
      set(id, { status: 'ready', geometry: normalizeProp(gltf.scene, prop), texture }),
    )
    .catch((err: unknown) => {
      console.warn(`[narco] modèle ${prop.model} non chargé, repli sur le cube`, err);
      set(id, { status: 'error' });
    });
}

export function propEntry(id: string): PropEntry | undefined {
  return cache.get(id);
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

/** État du prop `id` ; `wanted` déclenche le chargement (area chargée). */
export function usePropEntry(id: string, wanted: boolean): PropEntry | undefined {
  useEffect(() => {
    if (wanted) requestProp(id);
  }, [id, wanted]);
  return useSyncExternalStore(subscribe, () => cache.get(id));
}

/** Dimensions (m) du prop normalisé : emprise de la boîte, hauteur réelle. */
export function propSize(prop: Prop): { w: number; h: number; d: number } {
  const s = prop.height / (prop.bounds.max[1] - prop.bounds.min[1]);
  const w = (prop.bounds.max[0] - prop.bounds.min[0]) * s;
  const d = (prop.bounds.max[2] - prop.bounds.min[2]) * s;
  const turned = Math.abs(Math.round(prop.rotationY / 90)) % 2 === 1;
  return turned ? { w: d, h: prop.height, d: w } : { w, h: prop.height, d };
}

/** Cube neutre de repli : boîte du prop, couleur `config.props.fallbackColor`. */
export function fallbackGeometry(prop: Prop | undefined, config: GameConfig): BufferGeometry {
  const { w, h, d } = prop ? propSize(prop) : { w: 1, h: 1, d: 1 };
  const g = new BoxGeometry(w, h, d).translate(0, h / 2, 0).toNonIndexed();
  const count = g.attributes.position!.count;
  const c = shade(config.palette[config.props.fallbackColor], 0.8);
  const rgb = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) rgb.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new BufferAttribute(rgb, 3));
  g.setAttribute(
    'aCut',
    new BufferAttribute(new Float32Array(count).fill(prop?.cuttable ? 1 : 0), 1),
  );
  g.deleteAttribute('uv');
  g.computeBoundingBox();
  return g;
}

/**
 * Couleurs d'un prop pour le thème : d'origine (`keepColors`), sinon mêlées à la teinte de
 * palette (`tint`) modulée par la luminance d'origine. Renvoie la géométrie telle quelle ou une copie.
 */
export function tintedGeometry(g: BufferGeometry, prop: Prop, config: GameConfig): BufferGeometry {
  if (prop.keepColors || !prop.tint) return g;
  const out = g.clone();
  const tint = shade(config.palette[prop.tint], 1);
  const k = config.props.tintStrength;
  const color = out.attributes.color!;
  const c = new Color();
  for (let i = 0; i < color.count; i++) {
    c.setRGB(color.getX(i), color.getY(i), color.getZ(i));
    const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    color.setXYZ(
      i,
      c.r + (tint.r * lum * 2 - c.r) * k,
      c.g + (tint.g * lum * 2 - c.g) * k,
      c.b + (tint.b * lum * 2 - c.b) * k,
    );
  }
  return out;
}

// ---------------------------------------------------------------- atlas de textures des packs

const textures = new Map<string, Promise<Texture>>();

/** Chargement d'un atlas (remplacé sous Node par les tests : pas d'image DOM). */
let readTexture = (path: string): Promise<Texture> =>
  new TextureLoader().loadAsync(`${import.meta.env.BASE_URL}${path}`);

export function setTextureReader(reader: (path: string) => Promise<Texture>): void {
  readTexture = reader;
  textures.clear();
}

/**
 * Atlas d'un pack, chargé une fois et partagé par tous ses props : couleurs d'origine,
 * mipmaps, texels nets (aplats de couleur de l'atlas Kenney), espace sRGB.
 */
export function loadPropTexture(path: string): Promise<Texture> {
  let p = textures.get(path);
  if (!p) {
    p = readTexture(path).then((t) => {
      t.colorSpace = SRGBColorSpace;
      t.magFilter = NearestFilter;
      t.minFilter = NearestMipmapLinearFilter;
      t.generateMipmaps = true;
      t.wrapS = t.wrapT = RepeatWrapping;
      t.needsUpdate = true;
      return t;
    });
    textures.set(path, p);
  }
  return p;
}
