import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  AnimationMixer,
  Box3,
  PerspectiveCamera,
  ShaderLib,
  Vector3,
  type Material,
  type Object3D,
  type SkinnedMesh,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { gameData, THEME_IDS, type ThemeId } from '@narco/shared';
import {
  applyAppearance,
  clipsFor,
  disposeMaterials,
  instantiate,
  prepare,
} from './characterAssets';
import { loadTestModel, PUBLIC_DIR } from './testModel';
import { themedData } from '../city/themedData';

/**
 * Test de fumée de l'écran de sélection : chaque skin, avec les vrais fichiers et les vrais JSON,
 * pour chaque thème. Échoue sur toute exception, tout fichier manquant, tout shader non patché
 * ou tout personnage hors du cadre de l'aperçu (canvas « vide »).
 */
const { characters: cfg } = gameData.config;
const P = cfg.preview;

function previewCamera(): PerspectiveCamera {
  const cam = new PerspectiveCamera(P.fov, 1, 0.1, 50);
  cam.position.set(0, P.height, P.distance);
  cam.lookAt(0, P.lookY, 0);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  return cam;
}

function materialsOf(root: Object3D): Material[] {
  const out: Material[] = [];
  root.traverse((o) => {
    const m = (o as SkinnedMesh).material;
    if ((o as SkinnedMesh).isMesh) out.push(...(Array.isArray(m) ? m : [m]));
  });
  return out;
}

/** Passe le patch du shader sur le vrai source Lambert : chaque remplacement doit avoir lieu. */
function patchedShader(m: Material): WebGLProgramParametersWithUniforms {
  const shader = {
    uniforms: {},
    vertexShader: ShaderLib.lambert.vertexShader,
    fragmentShader: ShaderLib.lambert.fragmentShader,
  } as unknown as WebGLProgramParametersWithUniforms;
  m.onBeforeCompile(shader, undefined as never);
  return shader;
}

describe('écran de sélection : test de fumée', () => {
  it('tous les fichiers des skins et des animations communes existent (casse comprise)', () => {
    const files = [...gameData.characters.values()].map((c) => c.model);
    files.push(cfg.animations.library);
    for (const f of files) {
      expect(existsSync(join(PUBLIC_DIR, f)), f).toBe(true);
      expect(f, f).not.toMatch(/\s/);
    }
  });

  it("l'aperçu a son propre fond et ses lumières, identiques quel que soit le thème", () => {
    for (const id of THEME_IDS) {
      const data = themedData(gameData, id);
      expect(data.config.characters.preview).toEqual(P);
    }
    expect(P.background).not.toBe(gameData.config.palette.ground);
    expect(P.ambient.intensity + P.key.intensity).toBeGreaterThan(0);
  });

  it('chaque skin se charge, s’anime et se dessine dans le cadre, pour chaque thème', async () => {
    const lib = await loadTestModel(cfg.animations.library);
    expect(lib.animations.length).toBeGreaterThan(0);
    const cam = previewCamera();
    const failures: string[] = [];
    for (const theme of THEME_IDS as readonly ThemeId[]) {
      const data = themedData(gameData, theme);
      for (const c of data.characters.values()) {
        const where = `${theme}/${c.id}`;
        try {
          const gltf = await loadTestModel(c.model);
          const asset = {
            ...prepare(c, gltf.scene),
            clips: clipsFor(gltf.animations, lib.animations),
          };
          const root = instantiate(asset);
          applyAppearance(root, {});
          const mats = materialsOf(root);
          if (mats.length === 0) failures.push(`${where} : aucun matériau`);
          for (const m of mats) {
            if ('flatShading' in m && m.flatShading !== true)
              failures.push(`${where} : sans facettes`);
            if (m.userData.slotColors) {
              const s = patchedShader(m);
              if (!s.vertexShader.includes('slotShade') || !s.vertexShader.includes('slotTint'))
                failures.push(`${where} : patch du shader non appliqué`);
            }
          }
          const idle = asset.clips.find((x) => x.name === cfg.animations.idle);
          if (!idle) failures.push(`${where} : pas de clip ${cfg.animations.idle}`);
          const mixer = new AnimationMixer(root);
          if (idle) mixer.clipAction(idle).play();
          mixer.update(0.4);
          root.updateMatrixWorld(true);
          const box = new Box3().setFromObject(root, true);
          const h = box.max.y - box.min.y;
          if (!(h > c.height * c.scale * 0.7 && h < c.height * c.scale * 1.3))
            failures.push(`${where} : hauteur ${h.toFixed(2)} m`);
          const center = box.getCenter(new Vector3()).project(cam);
          const top = new Vector3(0, box.max.y, 0).project(cam);
          if (Math.abs(center.x) > 0.5 || Math.abs(center.y) > 0.5 || Math.abs(top.y) > 1)
            failures.push(`${where} : hors du cadre de l'aperçu`);
          mixer.stopAllAction();
          disposeMaterials(root);
        } catch (err) {
          failures.push(`${where} : ${(err as Error).message}`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);
});
