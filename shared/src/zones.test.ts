import { describe, expect, it } from 'vitest';
import { gameData } from './data';
import { cellIndex, createNavGrid, distancesFrom } from './navgrid';
import { STREET, interiorForLocation, nearestStation, zoneArea } from './zones';

const lab = gameData.interiors.get('lab')!;
const radius = gameData.config.world.playerRadius;

describe('zones', () => {
  it('charge le labo, relié à la porte du local', () => {
    expect(lab.entranceLocationId).toBe('local');
    expect(interiorForLocation(gameData, 'local')?.id).toBe('lab');
    expect(interiorForLocation(gameData, 'repaire_jefe')).toBeUndefined();
    const kinds = lab.stations.map((s) => s.kind).sort();
    expect(kinds).toEqual(['exit', 'pot', 'pot', 'rack', 'stock', 'table', 'water']);
  });

  it('donne bornes et obstacles par zone', () => {
    expect(zoneArea(gameData, STREET)!.bounds).toEqual(gameData.config.world.bounds);
    const area = zoneArea(gameData, 'lab')!;
    expect(area.bounds).toEqual({ minX: -7, maxX: 7, minZ: -5, maxZ: 5 });
    expect(area.obstacles).toHaveLength(lab.stations.filter((s) => s.solid).length);
    expect(zoneArea(gameData, 'cave')).toBeNull();
  });

  it('relie le shop et la supérette à leurs lieux de la rue', () => {
    expect(interiorForLocation(gameData, 'shop')?.id).toBe('shop');
    expect(interiorForLocation(gameData, 'epicerie')?.id).toBe('grocery');
    for (const id of ['shop', 'grocery']) {
      const kinds = gameData.interiors.get(id)!.stations.map((st) => st.kind);
      expect(kinds.filter((k) => k === 'shelf')).toHaveLength(3);
      expect(kinds.filter((k) => k === 'counter')).toHaveLength(1);
      expect(
        gameData.interiors.get(id)!.stations.find((st) => st.kind === 'counter')!.vendor,
      ).toBeTruthy();
    }
  });

  for (const interior of gameData.interiors.values()) {
    it(`rend chaque poste de "${interior.id}" atteignable depuis le point d’apparition`, () => {
      const area = zoneArea(gameData, interior.id)!;
      const grid = createNavGrid(area.bounds, area.obstacles, radius, 0.25);
      const dist = distancesFrom(grid, interior.spawn);
      for (const st of interior.stations) {
        let reachable = false;
        for (let a = 0; a < 32 && !reachable; a++) {
          for (let r = 0.2; r <= st.interactRadius && !reachable; r += 0.2) {
            const p = {
              x: st.position.x + Math.cos((a / 32) * Math.PI * 2) * r,
              z: st.position.z + Math.sin((a / 32) * Math.PI * 2) * r,
            };
            const i = cellIndex(grid, p);
            if (i >= 0 && Number.isFinite(dist[i]!)) reachable = true;
          }
        }
        expect(reachable, `${st.id} inaccessible`).toBe(true);
      }
    });
  }

  it('trouve le poste le plus proche dans son rayon', () => {
    expect(nearestStation({ x: -5, z: -1.6 }, lab)?.id).toBe('pot_1');
    expect(nearestStation(lab.spawn, lab)?.id).toBe('exit');
    expect(nearestStation({ x: 0, z: 0 }, lab)).toBeNull();
  });
});
