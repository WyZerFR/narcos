import { readPublic } from '../testScene';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, Profiler } from 'react';
import ReactThreeTestRenderer from '@react-three/test-renderer';
import { Box3, MeshBasicMaterial, Texture, type InstancedMesh, type Material } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { gameData } from '@narco/shared';
import { litMaterial } from '../materials';
import { applyCutout } from './cutout';
import { themedData } from './themedData';
import { areaIdNear } from '../areaStreaming';
import {
  normalizeProp,
  resetPropCache,
  setPropReader,
  setTextureReader,
  propEntry,
} from './propAssets';
import { PropKits, propDrawCalls, type PropItem } from './PropKits';

/**
 * Montage du décor importé avec les vrais GLB de `client/public` et les vrais JSON : un
 * InstancedMesh par prop, 120 ticks simulés, rendus bornés, repli sur le cube si un fichier manque.
 */
const TICKS = 120;
const MAX_RENDERS = 12;
const props = [...gameData.props.values()];
const data = themedData(gameData, 'cartel');
const spawn = gameData.config.players.spawn;
const area = areaIdNear(spawn);

afterEach(() => {
  vi.restoreAllMocks();
  resetPropCache();
});

async function mount(kits: Map<string, PropItem[]>) {
  const errors: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.join(' ')));
  let renders = 0;
  // atlas factice sous Node (pas d'image DOM) ; un matériau par atlas et par découpe
  setTextureReader(() => Promise.resolve(new Texture()));
  const made = new Map<string, Material>();
  const materialFor = (texture: Texture | null, cut: boolean): Material => {
    const key = `${texture?.uuid ?? 'sommets'}|${cut}`;
    if (!made.has(key)) {
      const m = litMaterial({ vertexColors: true, map: texture });
      made.set(key, cut ? applyCutout(m) : m);
    }
    return made.get(key)!;
  };
  const scene = await ReactThreeTestRenderer.create(
    createElement(
      Profiler,
      { id: 'props', onRender: () => void renders++ },
      createElement(PropKits, { kits, loaded: new Set([area]), data, materialFor }),
    ),
  );
  await ReactThreeTestRenderer.act(async () => {
    await scene.advanceFrames(TICKS, 1 / 60);
  });
  // chargements asynchrones (lecture + parse) puis rendu
  for (let i = 0; i < 20 && props.some((p) => propEntry(p.id)?.status === 'loading'); i++)
    await ReactThreeTestRenderer.act(() => new Promise((r) => setTimeout(r, 20)));
  await ReactThreeTestRenderer.act(async () => {
    await scene.advanceFrames(2, 1 / 60);
  });
  const meshes: InstancedMesh[] = [];
  scene.scene.allChildren.forEach((c) => {
    const o = c.instance as unknown as InstancedMesh;
    if (o.isInstancedMesh) meshes.push(o);
  });
  return { scene, errors, renders, meshes, made };
}

describe('décor 3D importé : chargement et rendu', () => {
  it('normalisation : pied à 0, centré, hauteur réelle, couleurs et aCut', async () => {
    for (const p of props) {
      const gltf = await new GLTFLoader().parseAsync(await readPublic(p.model), '');
      const g = normalizeProp(gltf.scene, p);
      const b = new Box3().setFromBufferAttribute(g.attributes.position as never);
      expect(b.min.y, p.id).toBeCloseTo(0, 3);
      expect(b.max.y, p.id).toBeCloseTo(p.height, 2);
      expect(b.min.x + b.max.x, p.id).toBeCloseTo(0, 2);
      expect(b.min.z + b.max.z, p.id).toBeCloseTo(0, 2);
      expect(g.attributes.color!.itemSize).toBe(3);
      expect(g.attributes.aCut!.getX(0)).toBe(p.cuttable ? 1 : 0);
      expect(g.index).toBeNull();
    }
  });

  it(`tous les modèles montés, ${TICKS} ticks, 1 draw call par prop, rendus bornés`, async () => {
    setPropReader(readPublic);
    const kits = new Map(props.map((p) => [p.id, [{ x: spawn.x, z: spawn.z }]]));
    const { scene, errors, renders, meshes, made } = await mount(kits);
    expect(errors).toEqual([]);
    expect(renders).toBeLessThanOrEqual(MAX_RENDERS);
    expect(meshes).toHaveLength(props.length);
    for (const m of meshes) {
      expect(m.count).toBe(1);
      // vrai modèle : plus qu'un cube (36 sommets)
      expect(m.geometry.attributes.position!.count).toBeGreaterThan(36);
    }
    const byCategory = propDrawCalls();
    expect(Object.values(byCategory).reduce((a, b) => a + b, 0)).toBe(props.length);
    // un atlas par pack texturé, partagé : au plus 2 matériaux (découpe ou non) par atlas
    const atlases = new Set(props.flatMap((p) => (p.texture ? [p.texture] : [])));
    expect(made.size).toBeLessThanOrEqual(2 * (atlases.size + 1));
    for (const m of meshes) {
      const p = props.find((q) => q.id === m.name);
      if (p) expect(Boolean((m.material as MeshBasicMaterial).map), p.id).toBe(Boolean(p.texture));
    }
    expect(meshes.every((m) => [...made.values()].includes(m.material as Material))).toBe(true);
    await scene.unmount();
    expect(Object.values(propDrawCalls()).every((n) => n === 0)).toBe(true);
  }, 60_000);

  it('modèle introuvable ou id inconnu : cube neutre, journalisé, aucune erreur', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setPropReader(() => Promise.reject(new Error('absent')));
    const kits = new Map([
      [props[0]!.id, [{ x: spawn.x, z: spawn.z }]],
      ['inconnu', [{ x: spawn.x, z: spawn.z }]],
    ]);
    const { scene, errors, meshes } = await mount(kits);
    expect(errors).toEqual([]);
    expect(meshes).toHaveLength(2);
    for (const m of meshes) expect(m.geometry.attributes.position!.count).toBe(36);
    expect(warn).toHaveBeenCalled();
    await scene.unmount();
  }, 60_000);

  it('chargement paresseux : rien demandé hors des areas chargées', async () => {
    setPropReader(readPublic);
    const far = { x: spawn.x + 10_000, z: spawn.z };
    const id = props[0]!.id;
    const unused = new MeshBasicMaterial();
    const scene = await ReactThreeTestRenderer.create(
      createElement(PropKits, {
        kits: new Map([[id, [far]]]),
        loaded: new Set(['aucune']),
        data,
        materialFor: () => unused,
      }),
    );
    expect(propEntry(id)).toBeUndefined();
    await scene.unmount();
  });
});

describe('gain de couleur du thème jour', () => {
  it('luminosité et saturation de la catégorie appliquées, couleurs d’origine sinon', async () => {
    const { tintedGeometry } = await import('./propAssets');
    const { BufferGeometry, Float32BufferAttribute } = await import('three');
    const p = props.find((x) => !x.texture)!;
    const g = new BufferGeometry();
    g.setAttribute('color', new Float32BufferAttribute([0.2, 0.4, 0.1], 3));
    expect(tintedGeometry(g, p, data.config, null)).toBe(g);
    const gain = gameData.propsTint[p.category];
    const out = tintedGeometry(g, p, data.config, gain).attributes.color!;
    const lum = 0.2126 * 0.2 + 0.7152 * 0.4 + 0.0722 * 0.1;
    expect(out.getY(0)).toBeCloseTo((lum + (0.4 - lum) * gain.saturation) * gain.brightness, 5);
  });
});
