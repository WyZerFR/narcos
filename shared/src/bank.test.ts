import { describe, expect, it } from 'vitest';
import { activeEntries, checkLaunder, launderRemaining, launderSplit, shiftLog } from './bank';
import type { BankRules } from './schemas';

const RULES: BankRules = {
  fee: 0.5,
  launderCap: 1000,
  capWindowSeconds: 60,
  step: 50,
  quickAmounts: [100, 500],
};
const base = { hasAccount: true, dirty: 2000, amount: 100, log: [], now: 100_000 };

describe('banque — commission et arrondi', () => {
  it('net = montant × (1 − fee), commission arrondie au dollar supérieur', () => {
    expect(launderSplit(100, 0.5)).toEqual({ commission: 50, net: 50 });
    expect(launderSplit(101, 0.5)).toEqual({ commission: 51, net: 50 });
    expect(launderSplit(1, 0.5)).toEqual({ commission: 1, net: 0 });
    // 100 × 0.3 = 30.000000000000004 en flottant : pas 31
    expect(launderSplit(100, 0.3)).toEqual({ commission: 30, net: 70 });
    expect(launderSplit(999, 0)).toEqual({ commission: 0, net: 999 });
  });
});

describe('banque — vérifications', () => {
  it('accepte et ajoute l’entrée au journal', () => {
    const r = checkLaunder(RULES, base);
    expect(r).toMatchObject({ ok: true, commission: 50, net: 50 });
    if (r.ok) expect(r.log).toEqual([{ at: 100_000, amount: 100 }]);
  });

  it('refus clairs : sans compte, sans argent, plus que le sac, montant invalide', () => {
    expect(checkLaunder(RULES, { ...base, hasAccount: false })).toMatchObject({
      ok: false,
      message: "Ouvrez d'abord un compte.",
    });
    expect(checkLaunder(RULES, { ...base, dirty: 0 })).toMatchObject({
      message: expect.stringMatching(/pas d'argent sale/),
    });
    expect(checkLaunder(RULES, { ...base, dirty: 50 })).toMatchObject({
      message: expect.stringMatching(/que 50 \$/),
    });
    for (const amount of [0, -5, 1.5, NaN])
      expect(checkLaunder(RULES, { ...base, amount })).toMatchObject({ ok: false });
  });

  it('plafond sur fenêtre glissante : refusé au-delà, libéré quand l’entrée sort', () => {
    const log = [
      { at: 50_000, amount: 600 },
      { at: 90_000, amount: 300 },
    ];
    expect(launderRemaining(log, 100_000, RULES)).toBe(100);
    expect(checkLaunder(RULES, { ...base, amount: 200, log })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/encore 100 \$/),
    });
    expect(checkLaunder(RULES, { ...base, amount: 100, log }).ok).toBe(true);
    // 60 s plus tard que la 1re entrée : elle sort de la fenêtre
    const later = 110_001;
    expect(activeEntries(log, later, RULES)).toEqual([{ at: 90_000, amount: 300 }]);
    const r = checkLaunder(RULES, { ...base, amount: 700, log, now: later });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.log.map((e) => e.amount)).toEqual([300, 700]);
    expect(
      checkLaunder(RULES, { ...base, amount: 100, log: [{ at: 0, amount: 1000 }], now: 59_999 }),
    ).toMatchObject({ message: 'Plafond atteint : revenez plus tard.' });
  });

  it('fenêtre gelée sans joueur : décaler le journal garde le plafond consommé', () => {
    const log = [{ at: 50_000, amount: 1000 }];
    const shifted = shiftLog(log, 30_000);
    expect(launderRemaining(log, 110_001, RULES)).toBe(1000);
    expect(launderRemaining(shifted, 110_001, RULES)).toBe(0);
  });
});
