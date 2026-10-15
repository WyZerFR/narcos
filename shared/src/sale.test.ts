import { describe, expect, it } from 'vitest';
import { cycleReport, starterKitCost } from './balance';
import { obstaclesFrom } from './collision';
import { gameData } from './data';
import { rectContainsPoint, expandRect } from './geometry';
import { add, count, emptyInventory } from './inventory';
import { createNavGrid, distancesFrom, findPath, isSegmentFree } from './navgrid';
import {
  areaBonusLabel,
  buyerProfile,
  pickName,
  pickProfile,
  rollDemand,
  sellPouches,
  unitPriceFor,
  type Demand,
} from './sale';

const { npcs, economy, config } = gameData;

/** Générateur pseudo-aléatoire reproductible. */
function lcg(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

describe('demande des PNJ', () => {
  it('reste dans les bornes du profil : quantité, budget, prix ± variation, patience', () => {
    const rng = lcg(42);
    const v = economy.sale.priceVariance;
    for (let i = 0; i < 500; i++) {
      const profile = pickProfile(npcs.profiles, rng);
      const d = rollDemand(profile, economy, rng);
      const base = economy.strains.find((s) => s.id === d.strainId)!.pouchSellPrice;
      expect(profile.strains).toContain(d.strainId);
      expect(d.qty).toBeGreaterThanOrEqual(1);
      expect(d.qty).toBeLessThanOrEqual(Math.min(3, profile.qty[1]));
      expect(d.unitPrice).toBeGreaterThanOrEqual(Math.round(base * (1 - v)));
      expect(d.unitPrice).toBeLessThanOrEqual(Math.round(base * (1 + v)));
      expect(d.qty * d.unitPrice).toBeLessThanOrEqual(Math.max(d.budget, d.unitPrice));
      expect(d.patienceMs).toBeGreaterThanOrEqual(profile.patienceSeconds[0] * 1000);
      expect(d.patienceMs).toBeLessThanOrEqual(profile.patienceSeconds[1] * 1000);
      if (profile.interestChance === 0) expect(d.interested).toBe(false);
    }
  });

  it('tire les profils selon leur poids', () => {
    const rng = lcg(7);
    const hits = new Map<string, number>();
    for (let i = 0; i < 4000; i++) {
      const p = pickProfile(npcs.profiles, rng);
      hits.set(p.id, (hits.get(p.id) ?? 0) + 1);
    }
    const total = npcs.profiles.reduce((s, p) => s + p.weight, 0);
    for (const p of npcs.profiles)
      expect((hits.get(p.id) ?? 0) / 4000).toBeCloseTo(p.weight / total, 1);
  });

  it('évite les prénoms déjà pris', () => {
    const taken = new Set(npcs.names.slice(1));
    expect(pickName(npcs.names, taken, lcg(1))).toBe(npcs.names[0]);
  });

  it('l’acheteur de debug est le profil le plus intéressé', () => {
    const best = Math.max(...npcs.profiles.map((p) => p.interestChance));
    expect(buyerProfile(npcs.profiles).interestChance).toBe(best);
  });
});

describe('vente de pochons', () => {
  const demand: Demand = {
    profileId: 'test',
    interested: true,
    strainId: 'base',
    qty: 2,
    budget: 50,
    unitPrice: 21,
    patienceMs: 10_000,
    area: 'street',
    priceMultiplier: 1,
  };
  const bagWith = (pouches: number) => {
    const r = add(emptyInventory(4), 'pouch_base', pouches, gameData.items);
    return r.ok ? r.inv : emptyInventory(4);
  };

  it('échange les pochons contre de l’argent sale', () => {
    const r = sellPouches(bagWith(3), demand, 2, gameData);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.amount).toBe(42);
    expect(count(r.bag, 'pouch_base')).toBe(1);
    expect(count(r.bag, 'cash_dirty')).toBe(42);
  });

  it('refuse sans rien toucher : pas intéressé, quantité hors offre, pochons manquants, sac plein', () => {
    expect(sellPouches(bagWith(3), { ...demand, interested: false }, 1, gameData).ok).toBe(false);
    expect(sellPouches(bagWith(3), demand, 3, gameData).ok).toBe(false);
    expect(sellPouches(bagWith(3), demand, 0, gameData).ok).toBe(false);
    const short = sellPouches(bagWith(1), demand, 2, gameData);
    expect(!short.ok && short.message).toMatch(/Pas assez/);
    let full = emptyInventory(2);
    const a = add(full, 'pouch_base', 3, gameData.items);
    if (a.ok) full = a.inv;
    const b = add(full, 'scissors', 1, gameData.items);
    if (b.ok) full = b.inv;
    const r = sellPouches(full, demand, 1, gameData);
    expect(!r.ok && r.message).toMatch(/Sac plein/);
  });
});

describe('navigation des PNJ', () => {
  const grid = createNavGrid(
    config.world.bounds,
    obstaclesFrom(gameData),
    config.npc.radius,
    config.npc.navCellSize,
  );

  it('chaque point de passage est hors bâtiment et accessible depuis les autres', () => {
    const inflated = obstaclesFrom(gameData).map((r) => expandRect(r, config.npc.radius));
    const field = distancesFrom(grid, npcs.waypoints[0]!);
    for (const wp of npcs.waypoints) {
      expect(inflated.some((r) => rectContainsPoint(r, wp))).toBe(false);
      expect(findPath(grid, wp, npcs.waypoints[0]!, field)).not.toBeNull();
    }
  });

  it('trouve un chemin lissé dont chaque segment est libre', () => {
    const from = npcs.waypoints[0]!;
    const to = npcs.waypoints[npcs.waypoints.length - 1]!;
    const path = findPath(grid, from, to)!;
    expect(path.at(-1)).toEqual(to);
    let prev = from;
    for (const p of path) {
      expect(isSegmentFree(grid, prev, p)).toBe(true);
      prev = p;
    }
  });

  it('renvoie null depuis un point bloqué', () => {
    const building = [...gameData.locations.values()].find((l) => l.kind === 'building')!;
    expect(findPath(grid, building.position, npcs.waypoints[0]!)).toBeNull();
  });
});

describe('équilibrage', () => {
  it('un cycle rapporte (graines du pacte, gratuites) : bénéfice positif par pot', () => {
    const kit = starterKitCost(gameData);
    const lines: string[] = [`Kit de départ : ${kit} $`];
    for (const strain of economy.strains) {
      for (const rate of [
        1,
        1 / (1 - economy.lab.lamp.maxLamps * economy.lab.lamp.growReductionPerLamp),
      ]) {
        const r = cycleReport(gameData, strain.id, rate);
        lines.push(
          `${strain.id} ${rate === 1 ? 'sans lampe' : 'lampes max'} : ${r.pouches} pochons × ${r.avgPrice} $ − graine ${r.seedCost} $ = ${r.profit} $ / cycle de ${Math.round(r.cycleSeconds)} s → ${r.profitPerMinute.toFixed(1)} $/min de jeu par pot`,
        );
        if (strain.unlockAct === 1) {
          expect(r.profit).toBeGreaterThan(0);
          // graines gratuites (pacte) : un cycle rembourse désormais le kit (constat d'équilibrage)
          expect(r.seedCost).toBe(0);
        }
      }
    }
    console.info(lines.join('\n'));
  });
});

describe('vente par area', () => {
  const profile = npcs.profiles[0]!;
  const fixed = (v: number) => () => v;
  const north = gameData.areas.get('north')!;
  const south = gameData.areas.get('south')!;

  it('prix multiplié par l’area du PNJ, arrondi une seule fois au dollar le plus proche', () => {
    const sale = gameData.economy.sale;
    // rng 0,5 : variation nulle → prix de base × multiplicateur
    expect(unitPriceFor(20, fixed(0.5), sale, 1.25)).toBe(25);
    expect(unitPriceFor(20, fixed(0.5), sale, 1.3)).toBe(26);
    expect(unitPriceFor(21, fixed(0.5), sale, 1.25)).toBe(26); // 26,25 → 26
    expect(unitPriceFor(1, fixed(0), sale, 0.5)).toBe(1); // jamais sous 1 $
    const street = rollDemand(profile, gameData.economy, fixed(0.5));
    const nord = rollDemand(profile, gameData.economy, fixed(0.5), north);
    expect(street.area).toBe('street');
    expect(nord.area).toBe('north');
    expect(nord.priceMultiplier).toBe(north.priceMultiplier);
    const base = gameData.economy.strains.find((s) => s.id === street.strainId)!.pouchSellPrice;
    expect(nord.unitPrice).toBe(Math.round(base * north.priceMultiplier));
    expect(street.unitPrice).toBe(base);
  });

  it('demandRate augmente la proportion de PNJ intéressés (plafonnée à 1)', () => {
    // tirage juste au-dessus de la chance du profil : refus en rue, achat au quartier
    const just = Math.min(0.999, profile.interestChance + 0.01);
    const seq = (values: number[]) => {
      let i = 0;
      return () => values[Math.min(i++, values.length - 1)]!;
    };
    const rngs = () => seq([0, just, 0.5, 0.5, 0.5, 0.5]);
    expect(rollDemand(profile, gameData.economy, rngs()).interested).toBe(false);
    if (profile.interestChance * south.demandRate > just)
      expect(rollDemand(profile, gameData.economy, rngs(), south).interested).toBe(true);
    const sure = { ...south, demandRate: 3 };
    expect(rollDemand(profile, gameData.economy, seq([0, 0.999, 0.5]), sure).interested).toBe(
      profile.interestChance * 3 >= 1,
    );
  });

  it('mention du bonus : « +25 % quartier », rien sans bonus', () => {
    expect(areaBonusLabel(1.25)).toBe('+25 % quartier');
    expect(areaBonusLabel(1.3)).toBe('+30 % quartier');
    expect(areaBonusLabel(1)).toBeNull();
  });
});
