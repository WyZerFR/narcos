import { describe, expect, it } from 'vitest';
import { isBlocked, obstaclesFrom } from './collision';
import { gameData } from './data';
import { interactionPoint } from './locations';
import { cellIndex, createNavGrid, distancesFrom, isFreeAt } from './navgrid';

const { config } = gameData;
const obstacles = obstaclesFrom(gameData);
const radius = config.world.playerRadius;
const grid = createNavGrid(config.world.bounds, obstacles, radius, 0.5);
const locations = [...gameData.locations.values()];

/** Limite haute demandée : traversée à pied en moins de 45 s. */
const MAX_WALK_SECONDS = 45;

describe('carte de la zone 1', () => {
  it('le point de départ est libre', () => {
    expect(isBlocked(config.players.spawn, radius, obstacles)).toBe(false);
    expect(isFreeAt(grid, config.players.spawn)).toBe(true);
  });

  it('chaque lieu a un point d’interaction libre et accessible depuis le départ', () => {
    const fromSpawn = distancesFrom(grid, config.players.spawn);
    for (const loc of locations) {
      const p = interactionPoint(loc);
      expect(isBlocked(p, radius, obstacles), `${loc.id} enfermé dans un obstacle`).toBe(false);
      const d = fromSpawn[cellIndex(grid, p)]!;
      expect(Number.isFinite(d), `${loc.id} inaccessible depuis le départ`).toBe(true);
    }
  });

  it(`relie les deux lieux les plus éloignés en moins de ${MAX_WALK_SECONDS} s à pied`, () => {
    let worst = { from: '', to: '', meters: 0 };
    for (const a of locations) {
      const dist = distancesFrom(grid, interactionPoint(a));
      for (const b of locations) {
        const m = dist[cellIndex(grid, interactionPoint(b))]!;
        if (m > worst.meters) worst = { from: a.id, to: b.id, meters: m };
      }
    }
    const seconds = worst.meters / config.movement.walkSpeed;
    expect(Number.isFinite(seconds)).toBe(true);
    expect(seconds, `${worst.from} → ${worst.to} : ${worst.meters.toFixed(0)} m`).toBeLessThan(
      MAX_WALK_SECONDS,
    );
  });

  it('se traverse de bord à bord en moins de 60 s à pied', () => {
    const { bounds } = config.world;
    const west = { x: bounds.minX + 1, z: 0 };
    const east = { x: bounds.maxX - 1, z: 0 };
    const north = { x: 0, z: bounds.minZ + 1 };
    const south = { x: 0, z: bounds.maxZ - 1 };
    const ew = distancesFrom(grid, west)[cellIndex(grid, east)]!;
    const ns = distancesFrom(grid, north)[cellIndex(grid, south)]!;
    expect(ew / config.movement.walkSpeed).toBeLessThan(60);
    expect(ns / config.movement.walkSpeed).toBeLessThan(60);
  });
});
