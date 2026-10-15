import { describe, expect, it } from 'vitest';
import { airportLayout, airportObstacles } from './airport';
import { areaAt } from './areas';
import { isBlocked, obstaclesFrom } from './collision';
import { areaWaypoints, gameData } from './data';
import { rectsOverlap } from './geometry';
import { cellCenter, cellIndex, createNavGrid, distancesFrom } from './navgrid';

const { config } = gameData;
const airport = config.airport;
const area = gameData.areas.get(airport.areaId)!;
const radius = config.world.playerRadius;
const layout = airportLayout(airport, area);
const outsideGate = { x: airport.gate.x, z: area.bounds.maxZ + 0.6 };
const insideGate = { x: airport.gate.x, z: airport.gate.z - 2 };

/** Données de la carte avec l'aéroport ouvert (déblocage futur), sans toucher à gameData. */
function unlocked() {
  const areas = new Map(gameData.areas);
  areas.set(area.id, { ...area, locked: false });
  return { ...gameData, areas };
}

describe('aéroport verrouillé', () => {
  const obstacles = obstaclesFrom(gameData);
  const grid = createNavGrid(config.world.bounds, obstacles, radius, 0.5);
  const fromSpawn = distancesFrom(grid, config.players.spawn);

  it('est verrouillé, au nord du centre-ville, sans PNJ', () => {
    expect(area.locked).toBe(true);
    expect(area.npcCount).toBe(0);
    expect(areaAt(gameData.areas.values(), outsideGate)?.id).toBe('centre_ville');
  });

  it('aucune entrée possible : portail fermé, aucune case de l’enceinte atteignable', () => {
    expect(airportObstacles(airport, gameData.areas)).toEqual([layout.gate]);
    expect(isBlocked(insideGate, radius, obstacles)).toBe(true);
    expect(isBlocked({ x: airport.gate.x, z: airport.gate.z }, radius, obstacles)).toBe(true);
    // devant le portail, côté ville : libre et atteignable (on le voit, on y bute)
    expect(isBlocked(outsideGate, radius, obstacles)).toBe(false);
    expect(Number.isFinite(fromSpawn[cellIndex(grid, outsideGate)])).toBe(true);
    let inside = 0;
    fromSpawn.forEach((d, i) => {
      if (Number.isFinite(d) && areaAt([area], cellCenter(grid, i))) inside++;
    });
    expect(inside).toBe(0);
  });

  it('aucun lieu, aucun point de passage de PNJ, aucun quartier à l’intérieur', () => {
    for (const loc of gameData.locations.values()) {
      expect(areaAt([area], loc.position), loc.id).toBeNull();
    }
    expect(areaWaypoints(gameData, area.id)).toEqual([]);
    expect([...gameData.quartiers.values()].some((q) => q.areaId === area.id)).toBe(false);
  });

  it('le portail coupe la clôture ; volumes dans l’enceinte', () => {
    expect(layout.fence.some((f) => rectsOverlap(f, layout.gate))).toBe(false);
    expect(layout.hangars.length).toBeGreaterThan(0);
    expect(layout.planes.length).toBeGreaterThan(0);
    expect(layout.containers.length).toBeGreaterThan(0);
  });
});

describe('aéroport déverrouillé (champ `locked` lu par la collision)', () => {
  const data = unlocked();
  const obstacles = obstaclesFrom(data);
  const grid = createNavGrid(config.world.bounds, obstacles, radius, 0.5);
  const fromGate = distancesFrom(grid, outsideGate);

  it('le portail s’ouvre : on entre par lui, la clôture tient ailleurs', () => {
    expect(isBlocked(insideGate, radius, obstacles)).toBe(false);
    expect(Number.isFinite(fromGate[cellIndex(grid, insideGate)])).toBe(true);
    // à côté du portail, la clôture bloque
    const beside = { x: airport.gate.x + airport.gate.width, z: airport.gate.z };
    expect(isBlocked(beside, radius, obstacles)).toBe(true);
  });
});
