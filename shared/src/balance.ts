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

export interface SurvivalCostReport {
  /** Prix le plus bas d'un point de faim / de soif en argent propre (articles « any » ou « clean »). */
  hungerPointPrice: number;
  thirstPointPrice: number;
  /** Argent propre dépensé en nourriture par minute de jeu (jauges tenues à flot). */
  perMinute: number;
  perHour: number;
  /** Argent sale à blanchir pour obtenir 1 $ propre (commission incluse). */
  dirtyPerClean: number;
  /** Pochons de base à vendre puis blanchir pour couvrir une heure de survie. */
  pouchesPerHour: number;
}

/** Coût de la survie payée en argent propre, et pochons à vendre puis blanchir pour le couvrir. */
export function survivalCostReport(
  data: Pick<GameData, 'economy' | 'shops' | 'items'>,
): SurvivalCostReport {
  let hungerPointPrice = Infinity;
  let thirstPointPrice = Infinity;
  for (const shop of data.shops.values())
    for (const shelf of shop.shelves) {
      if (shelf.currency === 'dirty') continue;
      const restores = data.items.get(shelf.itemId)?.restores;
      if (restores?.hunger)
        hungerPointPrice = Math.min(hungerPointPrice, shelf.price / restores.hunger);
      if (restores?.thirst)
        thirstPointPrice = Math.min(thirstPointPrice, shelf.price / restores.thirst);
    }
  const { survival, bank, strains } = data.economy;
  const perMinute =
    survival.hungerPerMinute * hungerPointPrice + survival.thirstPerMinute * thirstPointPrice;
  const perHour = perMinute * 60;
  const dirtyPerClean = 1 / (1 - bank.fee);
  return {
    hungerPointPrice,
    thirstPointPrice,
    perMinute,
    perHour,
    dirtyPerClean,
    pouchesPerHour: (perHour * dirtyPerClean) / strains[0]!.pouchSellPrice,
  };
}
