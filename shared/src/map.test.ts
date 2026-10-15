import { describe, expect, it } from 'vitest';
import { isBlocked, obstaclesFrom } from './collision';
import { gameData } from './data';
import { interactionPoint } from './locations';
import { cellCenter, cellIndex, createNavGrid, distancesFrom, isFreeAt } from './navgrid';
import { areaAt } from './areas';

const { config } = gameData;
const obstacles = obstaclesFrom(gameData);
const radius = config.world.playerRadius;
const grid = createNavGrid(config.world.bounds, obstacles, radius, 0.5);
const locations = [...gameData.locations.values()];
const walk = config.movement.walkSpeed;
const fromSpawn = distancesFrom(grid, config.players.spawn);
const secondsFromSpawn = (id: string) =>
  fromSpawn[cellIndex(grid, interactionPoint(gameData.locations.get(id)!))]! / walk;

/** Temps à pied (walkSpeed) demandés depuis le départ, en secondes. */
const MAX_FROM_SPAWN: Record<string, number> = {
  shop: 45, // Bricoshop, quartier commercial
  banque: 45, // centre-ville
  repaire_jefe: 90, // fond du U d'El Jefe
  local: 30, // fond de notre U
};
const MAX_CROSSING_SECONDS = 150;

/** Case accessible la plus éloignée d'un champ de distances. */
function farthest(dist: Float64Array): { index: number; meters: number } {
  let index = -1;
  let meters = 0;
  dist.forEach((d, i) => {
    if (Number.isFinite(d) && d > meters) [index, meters] = [i, d];
  });
  return { index, meters };
}

describe('carte de l’île', () => {
  it('le point de départ est libre, dans les Bas-fonds', () => {
    expect(isBlocked(config.players.spawn, radius, obstacles)).toBe(false);
    expect(isFreeAt(grid, config.players.spawn)).toBe(true);
    expect(areaAt(gameData.areas.values(), config.players.spawn)?.id).toBe('bas_fonds');
  });

  it('chaque lieu a un point d’interaction libre et accessible depuis le départ', () => {
    for (const loc of locations) {
      const p = interactionPoint(loc);
      expect(isBlocked(p, radius, obstacles), `${loc.id} enfermé dans un obstacle`).toBe(false);
      expect(Number.isFinite(secondsFromSpawn(loc.id)), `${loc.id} inaccessible`).toBe(true);
    }
  });

  it('chaque lieu est dans l’area prévue', () => {
    const areaOf = (id: string) =>
      areaAt(gameData.areas.values(), gameData.locations.get(id)!.position)?.id;
    expect(areaOf('epicerie')).toBe('bas_fonds');
    expect(areaOf('local')).toBe('chez_nous');
    expect(areaOf('trappe_cave')).toBe('chez_nous');
    expect(areaOf('repaire_jefe')).toBe('cartel');
    expect(areaOf('banque')).toBe('centre_ville');
    expect(areaOf('shop')).toBe('commercial');
  });

  for (const [id, max] of Object.entries(MAX_FROM_SPAWN))
    it(`départ → ${id} en moins de ${max} s à pied`, () => {
      const s = secondsFromSpawn(id);
      expect(s, `${id} : ${s.toFixed(1)} s`).toBeLessThan(max);
    });

  it(`traversée complète de l’île en moins de ${MAX_CROSSING_SECONDS} s à pied`, () => {
    // double balayage : point le plus loin du départ, puis le plus loin de celui-là
    const a = farthest(fromSpawn);
    const b = farthest(distancesFrom(grid, cellCenter(grid, a.index)));
    expect(b.meters / walk).toBeLessThan(MAX_CROSSING_SECONDS);
  });

  it('chaque area marchable est atteignable depuis le départ, l’aéroport verrouillé ne l’est pas', () => {
    for (const area of gameData.areas.values()) {
      let reached = false;
      fromSpawn.forEach((d, i) => {
        if (!reached && Number.isFinite(d)) reached = areaAt([area], cellCenter(grid, i)) !== null;
      });
      expect(reached, area.id).toBe(!area.locked);
    }
  });
});
