import { describe, expect, it } from 'vitest';
import { gameData, parseGameData } from './data';
import { areaAt, areasEnvelope, dangerAt, outsideAreas } from './areas';
import { areaSalesReport } from './balance';
import { rectContainsPoint } from './geometry';
import type { Area } from './schemas';
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

describe('areas', () => {
  it('trois areas : rue centrale, quartiers Nord et Sud, réglages des JSON', () => {
    expect(areas.map((a) => a.id)).toEqual(['street', 'north', 'south']);
    expect(byId('street').priceMultiplier).toBe(1);
    expect(byId('north').priceMultiplier).toBeGreaterThan(byId('south').priceMultiplier);
    expect(byId('south').priceMultiplier).toBeGreaterThan(1);
    expect([byId('street'), byId('north'), byId('south')].map((a) => a.dangerLevel)).toEqual([
      3, 1, 1,
    ]);
    expect(byId('north').controlledBy).toBe('eljefe');
    expect(byId('south').controlledBy).toBe('cartel');
    expect(byId('street').controlledBy).toBeNull();
  });

  it('areaAt : un point dans chaque area', () => {
    expect(at(0, 0)).toBe('street');
    expect(at(30, -30)).toBe('street');
    expect(at(0, -100)).toBe('north');
    expect(at(0, 100)).toBe('south');
  });

  it('areaAt : frontières (la rue l’emporte sur l’entrée des impasses)', () => {
    const n = byId('north').bounds;
    expect(at(0, n.maxZ)).toBe('street');
    expect(at(0, n.maxZ - 0.01)).toBe('north');
    expect(at(n.minX, -100)).toBe('north');
    expect(at(n.minX - 0.01, -100)).toBeNull();
    const s = byId('south').bounds;
    expect(at(0, s.minZ + 0.01)).toBe('south');
    expect(at(s.maxX, s.maxZ)).toBe('south');
  });

  it('areaAt : hors carte et hors impasses → null', () => {
    expect(at(1000, 0)).toBeNull();
    expect(at(40, -100)).toBeNull(); // à côté de l'impasse nord
    expect(at(0, 141)).toBeNull();
  });

  it('dangerAt suit l’area', () => {
    expect(dangerAt(areas, { x: 0, z: 0 })).toBe(3);
    expect(dangerAt(areas, { x: 0, z: -100 })).toBe(1);
    expect(dangerAt(areas, { x: 500, z: 0 })).toBeNull();
  });

  it('carte = enveloppe des areas ; le hors-zone couvre exactement le reste', () => {
    expect(areasEnvelope(areas)).toEqual(gameData.config.world.bounds);
    const outside = outsideAreas(areas, gameData.config.world.bounds);
    expect(outside).toHaveLength(4);
    for (const p of [
      { x: 40, z: -100 },
      { x: -40, z: 100 },
    ])
      expect(outside.some((r) => rectContainsPoint(r, p))).toBe(true);
    for (const p of [
      { x: 0, z: -100 },
      { x: 30, z: 0 },
    ])
      expect(outside.some((r) => rectContainsPoint(r, p))).toBe(false);
  });

  it('zod : areas.json invalide refusé ; chevauchement et carte incohérente refusés', () => {
    const raw = () => structuredClone(rawAll);
    const r1 = raw();
    (r1.areas as { areas: Area[] }).areas[1]!.dangerLevel = 9;
    expect(() => parseGameData(r1)).toThrow(/areas\.json invalide[\s\S]*dangerLevel/);
    const r2 = raw();
    (r2.areas as { areas: Area[] }).areas[1]!.bounds.maxZ = -40;
    expect(() => parseGameData(r2)).toThrow(/"street" chevauche "north"/);
    const r3 = raw();
    (r3.config as { world: { bounds: { maxZ: number } } }).world.bounds.maxZ = 150;
    expect(() => parseGameData(r3)).toThrow(/world\.bounds doit valoir l'enveloppe/);
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

  it('bâtiment du bout : au fond de l’impasse, porte vers la rue', () => {
    const jefe = gameData.locations.get('repaire_jefe')!;
    const local = gameData.locations.get('local')!;
    expect(areaAt(areas, jefe.position)?.id).toBe('north');
    expect(areaAt(areas, local.position)?.id).toBe('south');
    const r = structuredClone(rawAll);
    const loc = (r.locations as L).locations.find((l) => l.id === 'repaire_jefe')!;
    loc.door = 'north';
    loc.position.z += 5;
    expect(() => parseGameData(r)).toThrow(/porte de "repaire_jefe" doit regarder la rue/);
    expect(() => parseGameData(r)).toThrow(/façade de "repaire_jefe" doit être en z/);
  });
});

describe('équilibrage par area', () => {
  it('les quartiers rapportent plus que la rue, par pochon et par minute', () => {
    const report = areaSalesReport(gameData);
    const street = report.find((r) => r.areaId === 'street')!;
    for (const id of ['north', 'south']) {
      const r = report.find((x) => x.areaId === id)!;
      expect(r.priceVsStreet).toBeGreaterThan(1);
      expect(r.revenuePerMinute).toBeGreaterThan(street.revenuePerMinute);
    }
  });
});
