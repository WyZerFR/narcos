import { describe, expect, it } from 'vitest';
import { isBlocked, obstaclesFrom } from './collision';
import { gameData } from './data';
import { interactionPoint } from './locations';
import { cellIndex, createNavGrid, distancesFrom, isFreeAt } from './navgrid';
import { areaAt } from './areas';

const { config } = gameData;
const obstacles = obstaclesFrom(gameData);
const radius = config.world.playerRadius;
const grid = createNavGrid(config.world.bounds, obstacles, radius, 0.5);
const locations = [...gameData.locations.values()];
const walk = config.movement.walkSpeed;
const fromSpawn = distancesFrom(grid, config.players.spawn);
const metersFromSpawn = (id: string) =>
  fromSpawn[cellIndex(grid, interactionPoint(gameData.locations.get(id)!))]!;

/** Limites demandées : départ → bout d'impasse < 45 s, bout à bout < 60 s, centre < 45 s. */
const MAX_TO_END_SECONDS = 45;
const MAX_END_TO_END_SECONDS = 60;

describe('carte : rue centrale et impasses', () => {
  it('le point de départ est libre, dans la rue centrale', () => {
    expect(isBlocked(config.players.spawn, radius, obstacles)).toBe(false);
    expect(isFreeAt(grid, config.players.spawn)).toBe(true);
    expect(areaAt(gameData.areas.values(), config.players.spawn)?.id).toBe('street');
  });

  it('chaque lieu a un point d’interaction libre et accessible depuis le départ', () => {
    for (const loc of locations) {
      const p = interactionPoint(loc);
      expect(isBlocked(p, radius, obstacles), `${loc.id} enfermé dans un obstacle`).toBe(false);
      expect(Number.isFinite(metersFromSpawn(loc.id)), `${loc.id} inaccessible`).toBe(true);
    }
  });

  it(`bout de chaque impasse à moins de ${MAX_TO_END_SECONDS} s du départ à pied`, () => {
    for (const q of gameData.quartiers.values()) {
      const s = metersFromSpawn(q.landmarkLocationId) / walk;
      expect(s, `${q.landmarkLocationId} : ${s.toFixed(1)} s`).toBeLessThan(MAX_TO_END_SECONDS);
    }
  });

  it(`d’un bout d’impasse à l’autre en moins de ${MAX_END_TO_END_SECONDS} s à pied`, () => {
    const [a, b] = [...gameData.quartiers.values()].map((q) =>
      interactionPoint(gameData.locations.get(q.landmarkLocationId)!),
    );
    const m = distancesFrom(grid, a!)[cellIndex(grid, b!)]!;
    expect(Number.isFinite(m)).toBe(true);
    expect(m / walk).toBeLessThan(MAX_END_TO_END_SECONDS);
  });

  it(`lieux de la rue centrale reliés entre eux en moins de ${MAX_TO_END_SECONDS} s`, () => {
    const central = locations.filter(
      (l) => areaAt(gameData.areas.values(), l.position)?.id === 'street',
    );
    for (const a of central) {
      const dist = distancesFrom(grid, interactionPoint(a));
      for (const b of central) {
        const m = dist[cellIndex(grid, interactionPoint(b))]!;
        expect(m / walk, `${a.id} → ${b.id}`).toBeLessThan(MAX_TO_END_SECONDS);
      }
    }
  });
});
