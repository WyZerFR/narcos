import { describe, expect, it } from 'vitest';
import { gameData, parseGameData } from './data';
import {
  areaAt,
  areaNeighbors,
  nearestArea,
  areaRects,
  areasEnvelope,
  dangerAt,
  outsideAreas,
  polygonContainsPoint,
  walkableAreas,
} from './areas';
import { areaSalesReport } from './balance';
import { areaSpot } from './areaSpots';
import { isBlocked, obstaclesFrom } from './collision';
import { cellIndex, createNavGrid, distancesFrom } from './navgrid';
import { rectContainsPoint } from './geometry';
import configJson from '../data/config.json';
import economyJson from '../data/economy.json';
import itemsJson from '../data/items.json';
import locationsJson from '../data/locations.json';
import zonesJson from '../data/zones.json';
import shopsJson from '../data/shops.json';
import npcsJson from '../data/npcs.json';
import dialoguesJson from '../data/dialogues.json';
import areasJson from '../data/areas.json';
import quartiersJson from '../data/quartiers.json';
import charactersJson from '../data/characters.json';
import palettesJson from '../data/palettes.json';

const areas = [...gameData.areas.values()];
const at = (x: number, z: number) => areaAt(areas, { x, z })?.id ?? null;
const byId = (id: string) => gameData.areas.get(id)!;

describe('areas de l’île', () => {
  it('six areas du sud-ouest au nord-est, réglages des JSON', () => {
    expect(areas.map((a) => a.id)).toEqual([
      'bas_fonds',
      'chez_nous',
      'centre_ville',
      'commercial',
      'cartel',
      'aeroport',
    ]);
    const danger = Object.fromEntries(areas.map((a) => [a.id, a.dangerLevel]));
    expect(danger).toEqual({
      bas_fonds: 3,
      chez_nous: 1,
      centre_ville: 5,
      commercial: 3,
      cartel: 1,
      aeroport: 5,
    });
    expect(byId('chez_nous').priceMultiplier).toBe(1.3);
    expect(byId('cartel').priceMultiplier).toBe(1.3);
    expect(byId('centre_ville').priceMultiplier).toBe(1);
    expect(byId('commercial').priceMultiplier).toBe(1.15);
    expect(byId('chez_nous').controlledBy).toBe('cartel');
    expect(byId('cartel').controlledBy).toBe('eljefe');
    expect(areas.filter((a) => a.locked).map((a) => a.id)).toEqual(['aeroport']);
    expect(areas.reduce((n, a) => n + a.npcCount, 0)).toBeLessThanOrEqual(14);
  });

  it('areaAt : un point dans chaque area, et le polygone en L du commercial', () => {
    expect(at(-60, 5)).toBe('bas_fonds');
    expect(at(-95, 100)).toBe('chez_nous');
    expect(at(0, 0)).toBe('centre_ville');
    expect(at(75, -13)).toBe('commercial');
    expect(at(180, -20)).toBe('commercial'); // bras est, au-dessus du cartel
    expect(at(175, 60)).toBe('cartel');
    expect(at(0, -100)).toBe('aeroport');
    expect(at(100, 60)).toBeNull(); // creux du L : la mer
  });

  it('areaAt : frontières (la première déclarée l’emporte, bord compris)', () => {
    expect(at(-95, 35)).toBe('bas_fonds');
    expect(at(-95, 35.01)).toBe('chez_nous');
    expect(at(-45, 0)).toBe('bas_fonds');
    expect(at(-44.99, 0)).toBe('centre_ville');
    expect(at(150, 10)).toBe('commercial');
    expect(at(150, 10.01)).toBe('cartel');
    expect(at(135, 30)).toBe('commercial');
    expect(at(134.99, 30)).toBe('commercial');
    expect(at(135.01, 30)).toBe('cartel');
    expect(at(0, -45)).toBe('centre_ville');
    expect(at(0, -45.01)).toBe('aeroport');
  });

  it('areaAt : en mer → null', () => {
    expect(at(1000, 0)).toBeNull();
    expect(at(-100, -60)).toBeNull(); // au nord des Bas-fonds
    expect(at(0, 60)).toBeNull(); // au sud du centre-ville
    expect(at(-145.01, 0)).toBeNull();
  });

  it('dangerAt suit l’area', () => {
    expect(dangerAt(areas, { x: -60, z: 5 })).toBe(3);
    expect(dangerAt(areas, { x: 0, z: 0 })).toBe(5);
    expect(dangerAt(areas, { x: 175, z: 60 })).toBe(1);
    expect(dangerAt(areas, { x: 500, z: 0 })).toBeNull();
  });

  it('carte = enveloppe des areas ; le hors-zone couvre exactement le reste', () => {
    expect(areasEnvelope(areas)).toEqual(gameData.config.world.bounds);
    const world = gameData.config.world.bounds;
    const outside = outsideAreas(areas, world);
    const inSea = (p: { x: number; z: number }) => outside.some((r) => rectContainsPoint(r, p));
    for (const p of [
      { x: 100, z: 60 },
      { x: -100, z: -60 },
      { x: 0, z: 100 },
    ])
      expect(inSea(p)).toBe(true);
    for (const p of [
      { x: 0, z: -100 },
      { x: 30, z: 0 },
      { x: 180, z: -20 },
    ])
      expect(inSea(p)).toBe(false);
    // pavage exact : aires des areas + hors-zone = aire de la carte
    const surface = (rs: { minX: number; maxX: number; minZ: number; maxZ: number }[]) =>
      rs.reduce((s, r) => s + (r.maxX - r.minX) * (r.maxZ - r.minZ), 0);
    expect(surface(outside) + surface(areas.flatMap(areaRects))).toBeCloseTo(surface([world]));
    // l'aéroport verrouillé est hors-zone pour la collision
    expect(walkableAreas(areas).map((a) => a.id)).not.toContain('aeroport');
  });

  it('polygone rectiligne : point dedans, sur un bord, dans le creux d’un L', () => {
    const L = [
      { x: 0, z: 0 },
      { x: 10, z: 0 },
      { x: 10, z: 5 },
      { x: 5, z: 5 },
      { x: 5, z: 10 },
      { x: 0, z: 10 },
    ];
    expect(polygonContainsPoint(L, { x: 2, z: 8 })).toBe(true);
    expect(polygonContainsPoint(L, { x: 8, z: 2 })).toBe(true);
    expect(polygonContainsPoint(L, { x: 8, z: 8 })).toBe(false);
    expect(polygonContainsPoint(L, { x: 5, z: 7 })).toBe(true);
    expect(polygonContainsPoint(L, { x: 10, z: 5 })).toBe(true);
  });

  it('zod : areas.json invalide refusé ; chevauchement et carte incohérente refusés', () => {
    const raw = () => structuredClone(rawAll);
    type Raw = { areas: { dangerLevel: number; polygon: { x: number; z: number }[] }[] };
    const r1 = raw();
    (r1.areas as Raw).areas[1]!.dangerLevel = 9;
    expect(() => parseGameData(r1)).toThrow(/areas\.json invalide[\s\S]*dangerLevel/);
    const r2 = raw();
    // le quartier chez nous remonte dans les Bas-fonds
    for (const p of (r2.areas as Raw).areas[1]!.polygon) if (p.z === 35) p.z = 30;
    expect(() => parseGameData(r2)).toThrow(/"bas_fonds" chevauche "chez_nous"/);
    const r3 = raw();
    (r3.config as { world: { bounds: { maxZ: number } } }).world.bounds.maxZ = 150;
    expect(() => parseGameData(r3)).toThrow(/world\.bounds doit valoir l'enveloppe/);
    const r4 = raw();
    (r4.areas as Raw).areas[0]!.polygon[1] = { x: -40, z: -30 };
    expect(() => parseGameData(r4)).toThrow(/areas\.json invalide[\s\S]*rectiligne/);
  });
});

const rawAll = {
  config: configJson,
  economy: economyJson,
  items: itemsJson,
  locations: locationsJson,
  zones: zonesJson,
  shops: shopsJson,
  npcs: npcsJson,
  dialogues: dialoguesJson,
  areas: areasJson,
  quartiers: quartiersJson,
  characters: charactersJson,
  palettes: palettesJson,
};

describe('quartiers.json : validation', () => {
  type Q = { quartiers: { street: { roadWidth: number }; houses: { roofs: string[] } }[] };
  type L = { locations: { id: string; position: { x: number; z: number }; door: string }[] };

  it('zod : chaussée < 6 m et toit inconnu refusés', () => {
    const r = structuredClone(rawAll);
    (r.quartiers as Q).quartiers[0]!.street.roadWidth = 5;
    expect(() => parseGameData(r)).toThrow(/quartiers\.json invalide[\s\S]*roadWidth/);
    const r2 = structuredClone(rawAll);
    (r2.quartiers as Q).quartiers[0]!.houses.roofs = ['dome'];
    expect(() => parseGameData(r2)).toThrow(/quartiers\.json invalide[\s\S]*roofs/);
  });

  it('bâtiment du bout : au fond du U, porte vers l’entrée', () => {
    const jefe = gameData.locations.get('repaire_jefe')!;
    const local = gameData.locations.get('local')!;
    expect(areaAt(areas, jefe.position)?.id).toBe('cartel');
    expect(areaAt(areas, local.position)?.id).toBe('chez_nous');
    const r = structuredClone(rawAll);
    const loc = (r.locations as L).locations.find((l) => l.id === 'repaire_jefe')!;
    loc.door = 'south';
    loc.position.z += 5;
    expect(() => parseGameData(r)).toThrow(/porte de "repaire_jefe" doit regarder la rue/);
    expect(() => parseGameData(r)).toThrow(/façade de "repaire_jefe" doit être en z/);
  });
});

describe('équilibrage par area', () => {
  it('les quartiers en U rapportent plus que la rue des Bas-fonds, par pochon et par minute', () => {
    const report = areaSalesReport(gameData);
    const street = report.find((r) => r.areaId === 'bas_fonds')!;
    for (const id of ['chez_nous', 'cartel']) {
      const r = report.find((x) => x.areaId === id)!;
      expect(r.priceVsReference).toBeGreaterThan(1);
      expect(r.revenuePerMinute).toBeGreaterThan(street.revenuePerMinute);
    }
  });
});

describe('voisines et points d’arrivée', () => {
  const neighbors = areaNeighbors(gameData.areas.values());

  it('voisines directes : symétriques, le centre-ville touche tout le monde sauf le cartel', () => {
    for (const [id, list] of neighbors)
      for (const other of list) expect(neighbors.get(other), `${id} ↔ ${other}`).toContain(id);
    expect([...neighbors.get('centre_ville')!].sort()).toEqual(
      ['aeroport', 'bas_fonds', 'chez_nous', 'commercial'].sort(),
    );
    expect(neighbors.get('cartel')).toEqual(['commercial']);
    for (const a of gameData.areas.values())
      expect(neighbors.get(a.id)!.length, a.id).toBeGreaterThan(0);
  });

  it('décor côtier rattaché à l’area la plus proche', () => {
    expect(nearestArea(gameData.areas.values(), { x: -150, z: 0 })?.id).toBe('bas_fonds');
    expect(nearestArea(gameData.areas.values(), { x: 0, z: 50 })?.id).toBe('centre_ville');
  });

  it('chaque area a un point d’arrivée libre, atteignable depuis le départ', () => {
    const obstacles = obstaclesFrom(gameData);
    const r = gameData.config.world.playerRadius;
    const grid = createNavGrid(gameData.config.world.bounds, obstacles, r, 0.5);
    const fromSpawn = distancesFrom(grid, gameData.config.players.spawn);
    for (const a of gameData.areas.values()) {
      const p = areaSpot(gameData, a.id, obstacles)!;
      expect(p, a.id).not.toBeNull();
      expect(isBlocked(p, r, obstacles), a.id).toBe(false);
      expect(Number.isFinite(fromSpawn[cellIndex(grid, p)]), a.id).toBe(true);
      expect(areaAt(gameData.areas.values(), p)?.id).toBe(a.locked ? 'centre_ville' : a.id);
    }
  });
});

describe('mode debug ?shot=<area>', () => {
  it('un point visé dans chaque area, null pour une area inconnue', async () => {
    const { shotTarget } = await import('./shot');
    const { obstaclesFrom } = await import('./collision');
    const obstacles = obstaclesFrom(gameData);
    for (const a of gameData.areas.values()) {
      const p = shotTarget(gameData, a.id, obstacles);
      expect(p, a.id).not.toBeNull();
      expect(areaAt([a], p!), a.id).not.toBeNull();
    }
    expect(shotTarget(gameData, 'nulle_part', obstacles)).toBeNull();
    expect(gameData.config.debugShot.zoom).toBeGreaterThan(0);
  });
});
