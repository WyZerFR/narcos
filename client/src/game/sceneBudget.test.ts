import { readPublic } from './testScene';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import ReactThreeTestRenderer from '@react-three/test-renderer';
import type { InstancedMesh, Mesh, Object3D } from 'three';
import { areaSpot, gameData, obstaclesFrom, STREET, walkableAreas } from '@narco/shared';
import { City } from './city/City';
import { localPlayer } from './localPlayer';
import { propEntry, resetPropCache, setPropReader } from './city/propAssets';
import { propDrawCalls } from './city/PropKits';

/**
 * Draw calls par construction de la ville avec le décor importé (vrais GLB) : la scène est
 * montée, le joueur placé dans chaque area marchable (area + voisines chargées), puis chaque
 * objet visible compte pour un draw call (Mesh, InstancedMesh non vide ; sans frustum culling,
 * donc par excès). Hors ville : ombres blob (1), PNJ (2), 3 joueurs (2 chacun).
 */
const OUTSIDE_CITY = 1 + 2 + 3 * 2;
const { drawCallTarget, drawCallBudget } = gameData.config.props;

function drawObjects(root: Object3D): number {
  let n = 0;
  root.traverseVisible((o) => {
    const inst = o as InstancedMesh;
    if (inst.isInstancedMesh) n += inst.count > 0 ? 1 : 0;
    else if ((o as Mesh).isMesh) n++;
  });
  return n;
}

const settle = () => ReactThreeTestRenderer.act(() => new Promise((r) => setTimeout(r, 30)));

afterAll(() => resetPropCache());

describe('budget de draw calls avec le décor importé', () => {
  it.each(['day', 'cartel'] as const)(
    `%s : chaque area sous ${drawCallTarget} draw calls (objectif), toujours sous ${drawCallBudget}`,
    async (themeId) => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      setPropReader(readPublic);
      const spawn = gameData.config.players.spawn;
      Object.assign(localPlayer, { initialized: true, x: spawn.x, z: spawn.z, zone: STREET });
      const scene = await ReactThreeTestRenderer.create(
        createElement(City, { glowBoost: 1, lockVersion: 0, themeId, shadows: false }),
      );
      await ReactThreeTestRenderer.act(async () => {
        await scene.advanceFrames(4, 1 / 60);
      });
      const report: string[] = [];
      const obstacles = obstaclesFrom(gameData);
      for (const area of walkableAreas(gameData.areas.values())) {
        const p = areaSpot(gameData, area.id, obstacles)!;
        Object.assign(localPlayer, { x: p.x, z: p.z });
        // l'aiguillage d'area interroge la position toutes les 250 ms, puis les modèles se chargent
        for (let i = 0; i < 12; i++) await settle();
        for (
          let i = 0;
          i < 40 && [...gameData.props.keys()].some((id) => propEntry(id)?.status === 'loading');
          i++
        )
          await settle();
        await ReactThreeTestRenderer.act(async () => {
          await scene.advanceFrames(2, 1 / 60);
        });
        const calls = drawObjects(scene.scene.instance as unknown as Object3D) + OUTSIDE_CITY;
        const props = Object.entries(propDrawCalls())
          .map(([c, n]) => `${c} ${n}`)
          .join(', ');
        report.push(`${themeId} ${area.id} : ${calls} (décor 3D : ${props})`);
        expect(calls, report.join('\n')).toBeLessThanOrEqual(drawCallTarget);
        expect(calls).toBeLessThan(drawCallBudget);
      }
      console.info(report.join('\n'));
      await scene.unmount();
    },
    120_000,
  );
});
