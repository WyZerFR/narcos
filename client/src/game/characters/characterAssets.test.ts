import { describe, expect, it } from 'vitest';
import {
  Color,
  type Material,
  type MeshLambertMaterial,
  type Object3D,
  type SkinnedMesh,
} from 'three';
import { gameData } from '@narco/shared';
import { applyBodyState, instantiate, prepare } from './characterAssets';
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
      const root = instantiate({ template } as Parameters<typeof instantiate>[0]);
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
