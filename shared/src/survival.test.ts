import { describe, expect, it } from 'vitest';
import { gameData } from './data';
import { consume, decayVitals, isLow, koCashLoss, speedFactor } from './survival';

const rules = gameData.economy.survival;
const MIN = 60_000;
const full = { hunger: 100, thirst: 100, health: 100 };

describe('survie', () => {
  it('baisse au rythme configuré', () => {
    const { vitals, ko } = decayVitals(full, 5 * MIN, rules);
    expect(vitals.hunger).toBeCloseTo(100 - 5 * rules.hungerPerMinute);
    expect(vitals.thirst).toBeCloseTo(100 - 5 * rules.thirstPerMinute);
    expect(vitals.health).toBe(100);
    expect(ko).toBe(false);
  });

  it('ne dépend pas de la fréquence des mises à jour', () => {
    let v = full;
    for (let i = 0; i < 60; i++) v = decayVitals(v, MIN, rules).vitals;
    const once = decayVitals(full, 60 * MIN, rules).vitals;
    expect(v.hunger).toBeCloseTo(once.hunger);
    expect(v.thirst).toBeCloseTo(once.thirst);
    expect(v.health).toBeCloseTo(once.health);
  });

  it('ne perd de la santé que pendant le temps passé à 0', () => {
    const v = { hunger: 100, thirst: 2 * rules.thirstPerMinute, health: 100 };
    const r = decayVitals(v, 5 * MIN, rules).vitals; // soif à 0 au bout de 2 min
    expect(r.thirst).toBe(0);
    expect(r.health).toBeCloseTo(100 - 3 * rules.healthLossPerMinuteAtZero);
  });

  it('met KO quand la santé tombe à 0', () => {
    const r = decayVitals({ hunger: 0, thirst: 0, health: 5 }, MIN, rules);
    expect(r.ko).toBe(rules.healthLossPerMinuteAtZero >= 5);
    expect(r.vitals.health).toBe(Math.max(0, 5 - rules.healthLossPerMinuteAtZero));
  });

  it('réduit la vitesse sous le seuil bas', () => {
    const low = { ...full, hunger: rules.lowThreshold - 1 };
    expect(isLow(low, rules)).toBe(true);
    expect(speedFactor(low, rules)).toBe(rules.lowSpeedFactor);
    expect(speedFactor(full, rules)).toBe(1);
  });

  it('restaure en consommant, plafonné au maximum', () => {
    const water = gameData.items.get('water')!;
    const r = consume({ hunger: 50, thirst: 90, health: 80 }, water, rules)!;
    expect(r.thirst).toBe(rules.max);
    expect(r.hunger).toBe(50);
    expect(consume(full, gameData.items.get('seed_base')!, rules)).toBeNull();
  });

  it('calcule la perte d’argent sale au KO', () => {
    expect(koCashLoss(100, rules)).toBe(Math.floor(rules.koDirtyCashLossPercent));
    expect(koCashLoss(0, rules)).toBe(0);
  });
});
