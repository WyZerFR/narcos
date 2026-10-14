import { describe, expect, it } from 'vitest';
import configJson from '../data/config.json';
import economyJson from '../data/economy.json';
import itemsJson from '../data/items.json';
import locationsJson from '../data/locations.json';
import shopsJson from '../data/shops.json';
import npcsJson from '../data/npcs.json';
import zonesJson from '../data/zones.json';
import { gameData, parseGameData, type RawGameData } from './data';
import {
  fixtureObstacles,
  fixtureStation,
  interiorPlaces,
  lampRate,
  nearestPlace,
} from './fixtures';
import { plantPot, potGrowMs, potReadyAt, rebankPot, waterPot } from './production';
import { zoneArea } from './zones';
import { TEST_LAB_FIXTURES, installTestLabFixtures } from './testing/labFixtures';

const raw = (): RawGameData =>
  structuredClone({
    config: configJson,
    economy: economyJson,
    items: itemsJson,
    locations: locationsJson,
    zones: zonesJson,
    shops: shopsJson,
    npcs: npcsJson,
  });

const lab = gameData.interiors.get('lab')!;
/** Le labo du jeu est vide : on teste sur les emplacements de l'ancien labo meublé. */
const gameLabFixtures = lab.fixtures.length;
installTestLabFixtures();
const LAMP = gameData.economy.lab.lamp;
const strain = gameData.economy.strains.find((s) => s.id === 'base')!;
const S = 1000;

function must<T>(r: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

describe('emplacements du labo', () => {
  it('le labo du jeu est livré vide : robinet et porte seulement, aucun emplacement', () => {
    expect(gameLabFixtures).toBe(0);
    expect(lab.stations.map((s) => s.kind).sort()).toEqual(['exit', 'water']);
  });

  it('emplacements de test : 4 pots, 2 étendoirs, 1 table, 4 lampes', () => {
    const by = (t: string) => lab.fixtures.filter((f) => f.accepts === t).length;
    expect([by('pot'), by('drying_rack'), by('cutting_table'), by('lamp')]).toEqual([4, 2, 1, 4]);
  });

  it('un emplacement installé devient un poste ; les lampes ne bloquent pas', () => {
    const pot = lab.fixtures.find((f) => f.id === 'pot_1')!;
    expect(fixtureStation(pot)).toMatchObject({ id: 'pot_1', kind: 'pot', solid: true });
    const all = new Set(lab.fixtures.map((f) => f.id));
    expect(fixtureObstacles(lab, all)).toHaveLength(lab.fixtures.length - 4);
    expect(fixtureObstacles(lab, new Set())).toHaveLength(0);
    const base = zoneArea(gameData, 'lab')!.obstacles.length;
    expect(zoneArea(gameData, 'lab', fixtureObstacles(lab, all))!.obstacles.length).toBe(base + 7);
  });

  it('endroit le plus proche : emplacement vide sans poste, installé avec poste', () => {
    const pot = lab.fixtures.find((f) => f.id === 'pot_1')!;
    const near = { x: pot.position.x, z: pot.position.z + 1 };
    const empty = nearestPlace(near, interiorPlaces(lab, new Set()));
    expect(empty?.id).toBe('pot_1');
    expect(empty?.station).toBeUndefined();
    const installed = nearestPlace(near, interiorPlaces(lab, new Set(['pot_1'])));
    expect(installed?.station?.kind).toBe('pot');
    expect(nearestPlace({ x: 100, z: 100 }, interiorPlaces(lab, new Set()))).toBeNull();
  });

  it('refuse un emplacement qui chevauche un poste ou que rien ne peut équiper', () => {
    const r = raw();
    const z = r.zones as {
      interiors: { id: string; fixtures: { id: string; position: object }[] }[];
    };
    const labRaw = z.interiors.find((i) => i.id === 'lab')!;
    labRaw.fixtures = structuredClone([...TEST_LAB_FIXTURES]);
    expect(() => parseGameData(r)).not.toThrow();
    labRaw.fixtures[1]!.position = { ...labRaw.fixtures[0]!.position };
    expect(() => parseGameData(r)).toThrow(/se chevauchent/);
    const r2 = raw();
    (r2.zones as typeof z).interiors.find((i) => i.id === 'lab')!.fixtures = structuredClone([
      ...TEST_LAB_FIXTURES,
    ]);
    const items = r2.items as { items: { id: string; installs?: string }[] };
    delete items.items.find((i) => i.id === 'grow_lamp')!.installs;
    expect(() => parseGameData(r2)).toThrow(/aucun objet ne s'installe/);
  });

  it('refuse des lampes qui annuleraient la durée de pousse', () => {
    const r = raw();
    (r.economy as { lab: { lamp: { maxLamps: number } } }).lab.lamp.maxLamps = 5;
    expect(() => parseGameData(r)).toThrow(/maxLamps/);
  });
});

describe('lampes', () => {
  const pot = { x: 0, z: 0 };
  it('accélère selon les lampes à portée, cumul plafonné', () => {
    expect(lampRate(pot, [], LAMP)).toBe(1);
    expect(lampRate(pot, [{ x: LAMP.range + 0.1, z: 0 }], LAMP)).toBe(1);
    expect(lampRate(pot, [{ x: 1, z: 0 }], LAMP)).toBeCloseTo(1 / (1 - LAMP.growReductionPerLamp));
    const many = Array.from({ length: LAMP.maxLamps + 2 }, () => ({ x: 0.5, z: 0 }));
    expect(lampRate(pot, many, LAMP)).toBeCloseTo(
      1 / (1 - LAMP.maxLamps * LAMP.growReductionPerLamp),
    );
  });

  it('réduit la durée de pousse du pourcentage prévu (horloge simulée)', () => {
    const rate = lampRate(pot, [{ x: 1, z: 0 }], LAMP);
    let p = must(plantPot({ ...emptyPotRate(1) }, 'base', 0, rate));
    // arrosé « pour toujours » pour ne mesurer que la pousse
    p = { ...must(waterPot(p, 0, strain)), wateredUntil: 1e12 };
    const normal = strain.growSeconds * S;
    expect(potReadyAt(p, 0, strain)).toBeCloseTo(normal * (1 - LAMP.growReductionPerLamp), 0);
  });

  it('pose d’une lampe en cours de pousse : progression acquise conservée, suite plus rapide', () => {
    let p = must(plantPot(emptyPotRate(1), 'base', 0));
    p = { ...p, wateredUntil: 1e12 };
    const t = 30 * S;
    expect(potGrowMs(p, t, strain)).toBe(t);
    const rate = 1 / (1 - LAMP.growReductionPerLamp);
    const lit = rebankPot(p, t, strain, rate);
    expect(potGrowMs(lit, t, strain)).toBe(t); // pas de saut
    expect(potGrowMs(lit, t + 10 * S, strain)).toBeCloseTo(t + 10 * S * rate);
    // retrait : retour à la vitesse normale, toujours sans saut
    const off = rebankPot(lit, t + 10 * S, strain, 1);
    expect(potGrowMs(off, t + 10 * S, strain)).toBeCloseTo(t + 10 * S * rate);
    expect(potGrowMs(off, t + 20 * S, strain)).toBeCloseTo(t + 10 * S * rate + 10 * S);
    // pot vide : seule la vitesse change
    expect(rebankPot(emptyPotRate(1), t, strain, rate).rate).toBe(rate);
  });
});

describe('kit de départ', () => {
  it('l’argent sale de départ paie pot + étendoir + table + graines prévues', () => {
    const shelves = gameData.shops.get('shop')!.shelves;
    const price = (itemId: string) => {
      const shelf = shelves.find((s) => s.itemId === itemId);
      expect(shelf, `${itemId} doit être vendu au Bricoshop`).toBeDefined();
      return shelf!.price;
    };
    const kit =
      price('pot') +
      price('drying_rack') +
      price('cutting_table') +
      gameData.economy.lab.starterKitSeeds * price('seed_base');
    expect(gameData.economy.lab.starterKitSeeds).toBeGreaterThan(0);
    expect(gameData.economy.startingMoney.dirty).toBeGreaterThanOrEqual(kit);
  });

  it('chaque type d’emplacement a un objet vendu au Bricoshop', () => {
    const sold = new Set(gameData.shops.get('shop')!.shelves.map((s) => s.itemId));
    for (const type of ['pot', 'drying_rack', 'cutting_table', 'lamp'])
      expect(
        [...gameData.items.values()].some((it) => it.installs === type && sold.has(it.id)),
      ).toBe(true);
  });
});

function emptyPotRate(rate: number) {
  return { planted: false, strainId: '', growMsDone: 0, bankedAt: 0, wateredUntil: 0, rate };
}
