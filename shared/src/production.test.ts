import { describe, expect, it } from 'vitest';
import { clockNow, createClock, setClockScale } from './clock';
import { gameData } from './data';
import {
  emptyPot,
  hangPlants,
  harvestPot,
  isCutDone,
  plantPot,
  potProgress,
  potReadyAt,
  potStatus,
  pouchesFor,
  rackLoad,
  splitDried,
  startCut,
  strainItem,
  waterPot,
  type PotState,
} from './production';

const strain = gameData.economy.strains.find((s) => s.id === 'base')!;
const grow = strain.growSeconds * 1000;
const wet = strain.waterEverySeconds * 1000;
const S = 1000;

function must<T>(r: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

describe('horloge de jeu', () => {
  it('avance à la vitesse choisie, sans saut au changement de vitesse', () => {
    let c = createClock(1000, 50_000);
    expect(clockNow(c, 2000)).toBe(51_000);
    c = setClockScale(c, 60, 2000);
    expect(clockNow(c, 2000)).toBe(51_000);
    expect(clockNow(c, 3000)).toBe(111_000);
  });
});

describe('pot', () => {
  it('suit vide → à arroser → pousse → prêt', () => {
    let pot: PotState = emptyPot();
    expect(potStatus(pot, 0, strain)).toBe('empty');
    pot = must(plantPot(pot, 'base', 0));
    expect(potStatus(pot, 0, strain)).toBe('needs_water');
    pot = must(waterPot(pot, 0, strain));
    expect(potStatus(pot, 1, strain)).toBe('growing');
    expect(potReadyAt(pot, 1, strain)).toBe(grow <= wet ? grow : null);
  });

  it('ne pousse pas sans eau, et reprend après un nouvel arrosage', () => {
    let pot = must(plantPot(emptyPot(), 'base', 0));
    pot = must(waterPot(pot, 0, strain));
    // la terre sèche au bout de `wet` ; on attend bien plus longtemps sans arroser
    const late = wet + 10 * grow;
    expect(potStatus(pot, late, strain)).toBe(grow <= wet ? 'ready' : 'needs_water');
    expect(potProgress(pot, late, strain)).toBeCloseTo(Math.min(1, wet / grow));
    if (grow > wet) {
      pot = must(waterPot(pot, late, strain));
      const doneAt = late + (grow - wet);
      expect(potStatus(pot, doneAt - 1, strain)).toBe('growing');
      expect(potStatus(pot, doneAt, strain)).toBe('ready');
    }
  });

  it('refuse les actions incohérentes', () => {
    const empty = emptyPot();
    expect(waterPot(empty, 0, strain).ok).toBe(false);
    expect(harvestPot(empty, 0, strain).ok).toBe(false);
    const planted = must(plantPot(empty, 'base', 0));
    expect(plantPot(planted, 'base', 0).ok).toBe(false);
    const watered = must(waterPot(planted, 0, strain));
    expect(waterPot(watered, S, strain)).toMatchObject({ ok: false });
    expect(harvestPot(watered, S, strain).ok).toBe(false);
  });

  it('récolte un pot prêt : plantes fraîches et pot vidé', () => {
    let pot = must(plantPot(emptyPot(), 'base', 0));
    let t = 0;
    while (potStatus(pot, t, strain) !== 'ready') {
      if (potStatus(pot, t, strain) === 'needs_water') pot = must(waterPot(pot, t, strain));
      t += S;
    }
    const { pot: after, fresh } = must(harvestPot(pot, t, strain));
    expect(fresh).toBe(strain.freshPerPlant);
    expect(potStatus(after, t, strain)).toBe('empty');
    // récolter deux fois le même état : refus
    expect(harvestPot(after, t, strain).ok).toBe(false);
  });
});

describe('étendoir', () => {
  it('sèche en `dryingSeconds` et respecte sa capacité', () => {
    const cap = gameData.economy.lab.rackCapacity;
    let rack = must(hangPlants([], strain, 2, 0, cap));
    expect(rackLoad(rack)).toBe(2);
    expect(hangPlants(rack, strain, cap, 0, cap).ok).toBe(false);
    rack = must(hangPlants(rack, strain, 1, 10 * S, cap));
    const t = strain.dryingSeconds * S;
    const { dried, remaining } = splitDried(rack, t);
    expect(dried.map((e) => e.qty)).toEqual([2]);
    expect(remaining.map((e) => e.qty)).toEqual([1]);
  });
});

describe('table de découpe', () => {
  it('un travail à la fois, terminé à readyAt', () => {
    const secs = gameData.economy.lab.cuttingSeconds;
    const job = must(startCut(null, 'p1', 'base', 3, 0, secs));
    expect(startCut(job, 'p2', 'base', 1, 0, secs).ok).toBe(false);
    expect(isCutDone(job, secs * S - 1)).toBe(false);
    expect(isCutDone(job, secs * S)).toBe(true);
    expect(pouchesFor(job, strain)).toBe(3 * strain.pouchesPerDried);
  });
});

describe('objets par variété', () => {
  it('retrouve graine, plantes et pochon de la variété de base', () => {
    for (const c of ['seed', 'plant_fresh', 'plant_dried', 'pouch'] as const)
      expect(strainItem(gameData.items, c, 'base')?.strain).toBe('base');
  });
});
