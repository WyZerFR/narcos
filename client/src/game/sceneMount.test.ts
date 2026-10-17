import { readPublic } from './testScene';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createElement, Profiler } from 'react';
import ReactThreeTestRenderer from '@react-three/test-renderer';
import { Texture, type Mesh, type Object3D } from 'three';
import { areaSpot, gameData, obstaclesFrom, STREET, walkableAreas } from '@narco/shared';
import { City } from './city/City';
import { localPlayer } from './localPlayer';
import { propEntry, resetPropCache, setPropReader, setTextureReader } from './city/propAssets';

/**
 * Montage de la ville assemblée avec les vrais modèles : le joueur passe dans chaque area
 * marchable, 120 ticks simulés par area, aucune erreur, rendus de la ville bornés ; un modèle
 * en échec retombe sur son cube neutre (journalisé) sans casser la scène.
 */
const TICKS = 120;
/** Rendus de la ville pendant les 120 ticks d'une area, une fois les modèles chargés. */
const MAX_RENDERS = 6;

const settle = () => ReactThreeTestRenderer.act(() => new Promise((r) => setTimeout(r, 30)));

async function mountCity(themeId: 'day' | 'cartel' | 'neutral' | 'legacy_night') {
  let renders = 0;
  const spawn = gameData.config.players.spawn;
  Object.assign(localPlayer, { initialized: true, x: spawn.x, z: spawn.z, zone: STREET });
  const scene = await ReactThreeTestRenderer.create(
    createElement(
      Profiler,
      { id: 'city', onRender: () => void renders++ },
      createElement(City, {
        glowBoost: 1,
        lockVersion: 0,
        themeId,
        shadows: false,
        outlines: true,
      }),
    ),
  );
  return { scene, renders: () => renders };
}

async function visit(scene: Awaited<ReturnType<typeof mountCity>>['scene'], x: number, z: number) {
  Object.assign(localPlayer, { x, z });
  for (let i = 0; i < 12; i++) await settle();
  for (
    let i = 0;
    i < 40 && [...gameData.props.keys()].some((id) => propEntry(id)?.status === 'loading');
    i++
  )
    await settle();
}

afterAll(() => resetPropCache());

describe('ville assemblée : montage avec les vrais modèles', () => {
  it(`chaque area : ${TICKS} ticks, aucune erreur, rendus bornés`, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error');
    setPropReader(readPublic);
    setTextureReader(() => Promise.resolve(new Texture()));
    const { scene, renders } = await mountCity('day');
    const obstacles = obstaclesFrom(gameData);
    for (const area of walkableAreas(gameData.areas.values())) {
      const p = areaSpot(gameData, area.id, obstacles)!;
      await visit(scene, p.x, p.z);
      const before = renders();
      await ReactThreeTestRenderer.act(async () => {
        await scene.advanceFrames(TICKS, 1 / 60);
      });
      expect(renders() - before, area.id).toBeLessThanOrEqual(MAX_RENDERS);
      // façades, props fusionnés et kits modélisés présents
      const names = new Set<string>();
      (scene.scene.instance as unknown as Object3D).traverse((o) => names.add(o.name));
      expect(names.has('props_fusionnes'), area.id).toBe(true);
      expect(names.has('facades_fusionnees'), area.id).toBe(true);
    }
    expect(errors).not.toHaveBeenCalled();
    await scene.unmount();
  }, 120_000);

  it('modèles en échec : cube neutre journalisé, la scène reste montée', async () => {
    resetPropCache();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken = ['superette_batiment', 'voiture_berline', 'objet_lampadaire_crosse'];
    setPropReader((path) =>
      broken.some((id) => path.includes(id))
        ? Promise.reject(new Error('fichier absent'))
        : readPublic(path),
    );
    const { scene } = await mountCity('cartel');
    const sup = gameData.placements.areas.commercial!.find((q) => q.prop === 'superette_batiment')!;
    await visit(scene, sup.x, sup.z - 14);
    await ReactThreeTestRenderer.act(async () => {
      await scene.advanceFrames(TICKS, 1 / 60);
    });
    for (const id of broken) expect(propEntry(id)?.status, id).toBe('error');
    let meshes = 0;
    (scene.scene.instance as unknown as Object3D).traverse((o) => {
      if ((o as Mesh).isMesh) meshes++;
    });
    expect(meshes).toBeGreaterThan(10);
    expect(warn).toHaveBeenCalled();
    await scene.unmount();
  }, 120_000);
});
