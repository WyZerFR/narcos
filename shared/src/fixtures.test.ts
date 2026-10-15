import { describe, expect, it } from 'vitest';
import { gameData } from './data';
import {
  fixtureObstacles,
  fixtureStation,
  furnitureFixture,
  interiorPlaces,
  lampRate,
  nearestPlace,
  rotateOffset,
  furnitureFixtures,
  potLit,
  unlitPlantedPots,
} from './fixtures';
import { stickyNearest } from './zones';
import { plantPot, potGrowMs, potReadyAt, rebankPot, waterPot } from './production';

const lab = gameData.interiors.get('lab')!;
const LAMP = gameData.economy.lab.lamp;
const strain = gameData.economy.strains.find((s) => s.id === 'base')!;
const S = 1000;
const { items } = gameData;

function must<T>(r: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

describe('meubles posés', () => {
  it('le labo du jeu est livré vide et aménageable : robinet et porte seulement', () => {
    expect(lab.furnishable).toBe(true);
    expect(lab.stations.map((s) => s.kind).sort()).toEqual(['exit', 'water']);
    expect(gameData.interiors.get('shop')!.furnishable).toBe(false);
  });

  it('résout un meuble depuis items.json : type, empreinte tournée, portée, poste', () => {
    const rack = items.get('drying_rack')!.placeable!;
    const f = furnitureFixture({ id: 'f1', itemId: 'drying_rack', x: 1, z: 2, rot: 1 }, items)!;
    expect(f).toMatchObject({ accepts: 'drying_rack', rot: 1, mount: 'floor' });
    expect(f.size).toEqual({ w: rack.d, d: rack.w });
    expect(f.interactRadius).toBe(rack.interactRadius);
    expect(fixtureStation(f)).toMatchObject({ id: 'f1', kind: 'rack', solid: true });
    expect(furnitureFixture({ id: 'x', itemId: 'water', x: 0, z: 0, rot: 0 }, items)).toBeNull();
    expect(furnitureFixture({ id: 'r', itemId: 'pot', x: 0, z: 0, rot: 5 }, items)!.rot).toBe(1);
  });

  it('les lampes au plafond ne bloquent pas le sol', () => {
    const pot = furnitureFixture({ id: 'p', itemId: 'pot', x: 0, z: 0, rot: 0 }, items)!;
    const lamp = furnitureFixture({ id: 'l', itemId: 'grow_lamp', x: 0, z: 0, rot: 0 }, items)!;
    expect(fixtureObstacles([pot, lamp])).toHaveLength(1);
    expect(fixtureStation(lamp).solid).toBe(false);
  });

  it('rotation des décalages locaux par quart de tour', () => {
    expect(rotateOffset(1, 0, 0)).toEqual({ x: 1, z: 0 });
    expect(rotateOffset(1, 0, 1)).toEqual({ x: 0, z: -1 });
    expect(rotateOffset(1, 0, 2)).toEqual({ x: -1, z: -0 });
    expect(rotateOffset(1, 0, 3)).toEqual({ x: -0, z: 1 });
  });

  it('endroit le plus proche : poste fixe ou meuble posé à sa position réelle', () => {
    const pot = furnitureFixture({ id: 'f7', itemId: 'pot', x: 3, z: -2, rot: 0 }, items)!;
    const places = interiorPlaces(lab, [pot]);
    expect(nearestPlace({ x: 3, z: -1 }, places)?.station.kind).toBe('pot');
    expect(nearestPlace({ x: 3, z: -1 }, places)?.fixture?.id).toBe('f7');
    expect(nearestPlace({ x: -6.3, z: 1.6 }, places)?.id).toBe('water');
    expect(nearestPlace({ x: 100, z: 100 }, places)).toBeNull();
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
  it('l’argent de départ (propre) paie pot + étendoir + table ; graines du pacte', () => {
    const shelves = gameData.shops.get('shop')!.shelves;
    const price = (itemId: string) => {
      const shelf = shelves.find((s) => s.itemId === itemId);
      expect(shelf, `${itemId} doit être vendu au Bricoshop`).toBeDefined();
      return shelf!.price;
    };
    const kit = price('pot') + price('drying_rack') + price('cutting_table');
    // plus aucune graine au Bricoshop : elles viennent d'El Jefe (pacte)
    expect(shelves.some((s) => gameData.items.get(s.itemId)?.category === 'seed')).toBe(false);
    expect(gameData.economy.pact.startSeeds).toBeGreaterThan(0);
    expect(gameData.economy.startingMoney.clean).toBeGreaterThanOrEqual(kit);
  });

  it('chaque type de meuble a un objet posable vendu au Bricoshop', () => {
    const sold = new Set(gameData.shops.get('shop')!.shelves.map((s) => s.itemId));
    for (const type of ['pot', 'drying_rack', 'cutting_table', 'lamp'])
      expect(
        [...gameData.items.values()].some((it) => it.placeable?.type === type && sold.has(it.id)),
      ).toBe(true);
  });
});

function emptyPotRate(rate: number) {
  return { planted: false, strainId: '', growMsDone: 0, bankedAt: 0, wateredUntil: 0, rate };
}

describe('lampe obligatoire pour planter', () => {
  const { economy } = gameData;
  const range = economy.lab.lamp.range;
  const lab = gameData.interiors.get('lab')!;
  /** Un pot en (0, 0) et une lampe en (x, z). */
  const layout = (x: number, z = 0) =>
    furnitureFixtures(
      [
        { id: 'p', itemId: 'pot', x: 0, z: 0, rot: 0 },
        { id: 'l', itemId: 'grow_lamp', x, z, rot: 0 },
      ],
      gameData.items,
    );

  it('pot éclairé à portée (economy.lab.lamp.range), pas au-delà', () => {
    expect(potLit({ x: 0, z: 0 }, [{ x: range, z: 0 }], range)).toBe(true);
    expect(potLit({ x: 0, z: 0 }, [{ x: range + 0.1, z: 0 }], range)).toBe(false);
    expect(potLit({ x: 0, z: 0 }, [], range)).toBe(false);
    expect(unlitPlantedPots(layout(range + 0.1), () => true, range)).toEqual(['p']);
    expect(unlitPlantedPots(layout(range - 0.1), () => true, range)).toEqual([]);
    expect(unlitPlantedPots(layout(range + 0.1), () => false, range)).toEqual([]);
  });

  it('le pot prime sur une lampe superposée, même plus proche du joueur', () => {
    const places = interiorPlaces(lab, layout(0, 0.3));
    const player = { x: 0, z: 0.8 };
    expect(nearestPlace(player, places)?.id).toBe('p');
    expect(stickyNearest(player, places, 'l', gameData.config.world.interactExitMargin)?.id).toBe(
      'p',
    );
  });

  it('150 $ : pot, étendoir, table, lampe et 2 articles de nourriture', () => {
    const shelves = [...gameData.shops.values()].flatMap((sh) => sh.shelves);
    const price = (itemId: string) => shelves.find((sh) => sh.itemId === itemId)!.price;
    const food = shelves
      .filter((sh) => gameData.items.get(sh.itemId)!.category === 'food' && sh.currency !== 'dirty')
      .map((sh) => sh.price)
      .sort((a, b) => a - b);
    expect(food.length).toBeGreaterThanOrEqual(1);
    const kit = ['pot', 'drying_rack', 'cutting_table', 'grow_lamp'].map(price);
    const total = kit.reduce((a, b) => a + b, 0) + 2 * food[0]!;
    expect(total).toBeLessThanOrEqual(economy.startingMoney.clean);
  });
});
