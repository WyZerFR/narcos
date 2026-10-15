import { describe, expect, it } from 'vitest';
import {
  Color,
  ShaderLib,
  type Material,
  type MeshLambertMaterial,
  type Object3D,
  type SkinnedMesh,
  type Vector4,
} from 'three';
import { gameData } from '@narco/shared';
import {
  applyAppearance,
  applyBodyState,
  characterMaterial,
  instantiate,
  prepare,
} from './characterAssets';
import { loadTestModel } from './testModel';

/** Couleurs d'origine (matériaux du fichier) avant toute fusion. */
function sourceColors(root: Object3D): Set<string> {
  const out = new Set<string>();
  root.traverse((o) => {
    const m = (o as { material?: Material & { color?: Color } }).material;
    if (m?.color) out.add(m.color.getHexString());
  });
  return out;
}

function meshesOf(root: Object3D): SkinnedMesh[] {
  const list: SkinnedMesh[] = [];
  root.traverse((o) => {
    if ((o as SkinnedMesh).isMesh) list.push(o as SkinnedMesh);
  });
  return list;
}

async function assetOf(id: string) {
  const character = gameData.characters.get(id)!;
  const gltf = await loadTestModel(character.model);
  const colors = sourceColors(gltf.scene);
  return { character, colors, ...prepare(character, gltf.scene) };
}

describe('modèle de personnage', () => {
  it('chaque id charge son propre fichier (pas de repli sur perso_1)', async () => {
    const a = await assetOf('perso_1');
    const b = await assetOf('perso_2');
    expect(b.character.model).not.toBe(a.character.model);
    expect(b.triangles).not.toBe(a.triangles);
  });

  for (const id of gameData.characters.keys())
    it(`${id} : 1 draw call, couleurs d'origine, aucune teinte du joueur`, async () => {
      const { template, colors, drawCalls } = await assetOf(id);
      expect(drawCalls).toBe(1);
      const root = instantiate({ template });
      applyBodyState(root, false);
      applyBodyState(root, true);
      const [mesh] = meshesOf(root);
      const mat = mesh!.material as MeshLambertMaterial;
      // corps intact : blanc × couleurs de sommets, aucun émissif
      expect(mat.color.getHexString()).toBe('ffffff');
      expect(mat.emissive.getHexString()).toBe('000000');
      const attr = mesh!.geometry.getAttribute('color');
      const seen = new Set<string>();
      for (let i = 0; i < attr.count; i++)
        seen.add(new Color(attr.getX(i), attr.getY(i), attr.getZ(i)).getHexString());
      expect(seen).toEqual(colors);
      expect(mat.transparent).toBe(true);
    });
});

describe('couleurs par slot', () => {
  const uniforms = (root: Object3D) =>
    (meshesOf(root)[0]!.material as Material).userData.slotColors as Vector4[];

  it('slot par sommet déduit du nom de matériau, nuance ≤ 1', async () => {
    const { template, character } = await assetOf('perso_2');
    const geo = meshesOf(template)[0]!.geometry;
    const attr = geo.getAttribute('slotShade');
    expect(attr.itemSize).toBe(2);
    const used = new Set<number>();
    for (let i = 0; i < attr.count; i++) {
      used.add(attr.getX(i));
      expect(attr.getY(i)).toBeGreaterThan(0);
      expect(attr.getY(i)).toBeLessThanOrEqual(1);
    }
    const expected = Object.keys(character.slots).map(
      (s) => gameData.appearanceSlots.get(s)!.index,
    );
    expect([...used].sort()).toEqual([0, ...expected].sort());
  });

  it('même modèle, deux joueurs, couleurs différentes : uniforms propres, 1 draw call chacun', async () => {
    const { template } = await assetOf('perso_2');
    const a = instantiate({ template });
    const b = instantiate({ template });
    applyAppearance(a, { top: 'tissu_8' });
    applyAppearance(b, { top: 'tissu_5', skin: 'peau_10' });
    const top = gameData.appearanceSlots.get('top')!.index;
    const skin = gameData.appearanceSlots.get('skin')!.index;
    const red = new Color('#d6402f');
    expect(uniforms(a)[top]!.toArray()).toEqual([red.r, red.g, red.b, 1]);
    expect(uniforms(a)[skin]!.w).toBe(0);
    expect(uniforms(b)[top]!.x).not.toBe(uniforms(a)[top]!.x);
    expect(uniforms(b)[skin]!.w).toBe(1);
    expect(meshesOf(a)).toHaveLength(1);
    expect(meshesOf(b)).toHaveLength(1);
    expect(meshesOf(a)[0]!.material).not.toBe(meshesOf(b)[0]!.material);
    // même programme pour tous : pas de matériau supplémentaire par couleur
    const ma = meshesOf(a)[0]!.material as Material;
    const mb = meshesOf(b)[0]!.material as Material;
    expect(ma.customProgramCacheKey()).toBe(mb.customProgramCacheKey());
    applyAppearance(a, {});
    expect(uniforms(a).every((u) => u.w === 0)).toBe(true);
  });

  it('shader : couleur de la palette × nuance d’origine sur les slots actifs', () => {
    const mat = characterMaterial();
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: ShaderLib.lambert.vertexShader,
      fragmentShader: ShaderLib.lambert.fragmentShader,
    };
    mat.onBeforeCompile(shader as never, undefined as never);
    expect(shader.vertexShader).toContain('attribute vec2 slotShade;');
    expect(shader.vertexShader).toContain(
      `uniform vec4 slotColors[${gameData.appearanceSlots.size + 1}];`,
    );
    expect(shader.vertexShader).toContain('slotTint.rgb * slotShade.y');
    expect(shader.uniforms.slotColors!.value).toBe(mat.userData.slotColors);
  });
});
