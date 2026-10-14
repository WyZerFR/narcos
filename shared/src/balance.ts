import type { GameData } from './data';

/**
 * Équilibrage (pur) : rentabilité d'un pot sur un cycle complet graine → pochons vendus,
 * au prix moyen de la rue. Sert au script `npm run balance` et à un test de garde-fou.
 */

export interface CycleReport {
  strainId: string;
  /** Vitesse de pousse (1 = sans lampe). */
  rate: number;
  seedCost: number;
  pouches: number;
  /** Prix moyen d'un pochon dans la rue ($). */
  avgPrice: number;
  revenue: number;
  profit: number;
  /** Durée d'un cycle (s de jeu) : pousse + séchage + découpe. */
  cycleSeconds: number;
  profitPerMinute: number;
}

function seedPrice(data: Pick<GameData, 'shops' | 'items'>, strainId: string): number {
  for (const shop of data.shops.values())
    for (const shelf of shop.shelves) {
      const item = data.items.get(shelf.itemId);
      if (item?.category === 'seed' && item.strain === strainId) return shelf.price;
    }
  return Infinity; // graine introuvable : cycle impossible à démarrer
}

export function cycleReport(
  data: Pick<GameData, 'economy' | 'shops' | 'items'>,
  strainId: string,
  rate = 1,
): CycleReport {
  const strain = data.economy.strains.find((s) => s.id === strainId)!;
  const seedCost = seedPrice(data, strainId);
  const pouches = strain.freshPerPlant * strain.pouchesPerDried;
  // variation symétrique autour du prix de base : la moyenne est le prix de base
  const avgPrice = strain.pouchSellPrice;
  const revenue = pouches * avgPrice;
  const profit = revenue - seedCost;
  const cycleSeconds =
    strain.growSeconds / rate + strain.dryingSeconds + data.economy.lab.cuttingSeconds;
  return {
    strainId,
    rate,
    seedCost,
    pouches,
    avgPrice,
    revenue,
    profit,
    cycleSeconds,
    profitPerMinute: (profit / cycleSeconds) * 60,
  };
}

/** Coût du kit minimal (pot + étendoir + table + graines prévues) au Bricoshop. */
export function starterKitCost(data: Pick<GameData, 'economy' | 'shops' | 'items'>): number {
  const priceOf = (installs: string) => {
    for (const shop of data.shops.values())
      for (const shelf of shop.shelves)
        if (data.items.get(shelf.itemId)?.placeable?.type === installs) return shelf.price;
    return Infinity;
  };
  const base = data.economy.strains[0]!.id;
  return (
    priceOf('pot') +
    priceOf('drying_rack') +
    priceOf('cutting_table') +
    data.economy.lab.starterKitSeeds * seedPrice(data, base)
  );
}
