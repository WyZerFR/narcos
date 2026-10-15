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

/**
 * Prix d'une graine : prix en rayon si elle est vendue, 0 si c'est la graine du pacte d'El Jefe
 * (seule source de graines, gratuite), Infinity sinon (cycle impossible à démarrer).
 */
function seedPrice(data: Pick<GameData, 'shops' | 'items' | 'economy'>, strainId: string): number {
  for (const shop of data.shops.values())
    for (const shelf of shop.shelves) {
      const item = data.items.get(shelf.itemId);
      if (item?.category === 'seed' && item.strain === strainId) return shelf.price;
    }
  const pactSeed = data.items.get(data.economy.pact.seedItemId);
  return pactSeed?.strain === strainId ? 0 : Infinity;
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

/** Coût du kit minimal (pot + étendoir + table + lampe + graines prévues) au Bricoshop. */
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
    priceOf('lamp') +
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
  const { survival, launder, strains } = data.economy;
  const bank = launder.venues.bank;
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

export interface AreaSalesReport {
  areaId: string;
  name: string;
  npcCount: number;
  priceMultiplier: number;
  /** Prix moyen d'un pochon de base dans l'area ($). */
  avgPrice: number;
  /** Pochons achetés par minute de jeu au mieux (chaque acheteur trouvé). */
  pouchesPerMinute: number;
  revenuePerMinute: number;
  /** Revenu d'un pochon comparé à l'area de référence (Bas-fonds, 1 = pareil). */
  priceVsReference: number;
}

/**
 * Débouché de la vente par area, depuis les JSON : PNJ de l'area × pochons par passage
 * (chance d'intérêt × demandRate, plafonnée à 1) / cooldown moyen, au prix × multiplicateur.
 */
export function areaSalesReport(
  data: Pick<GameData, 'economy' | 'npcs' | 'areas' | 'config' | 'marketReference'>,
): AreaSalesReport[] {
  const { profiles } = data.npcs;
  const totalWeight = profiles.reduce((s, p) => s + p.weight, 0);
  const [c0, c1] = data.config.npc.cooldownSeconds;
  const cooldownMin = (c0 + c1) / 2 / 60;
  const base = data.economy.strains[0]!.pouchSellPrice;
  // référence des prix : Bas-fonds (areas.json referenceAreaId, multiplicateur 1)
  const reference = data.marketReference.priceMultiplier;
  return [...data.areas.values()].map((a) => {
    const perVisit = profiles.reduce(
      (s, p) =>
        s +
        (p.weight / totalWeight) *
          Math.min(1, p.interestChance * a.demandRate) *
          ((p.qty[0] + p.qty[1]) / 2),
      0,
    );
    const pouchesPerMinute = (a.npcCount * perVisit) / cooldownMin;
    const avgPrice = base * a.priceMultiplier;
    return {
      areaId: a.id,
      name: a.name,
      npcCount: a.npcCount,
      priceMultiplier: a.priceMultiplier,
      avgPrice,
      pouchesPerMinute,
      revenuePerMinute: pouchesPerMinute * avgPrice,
      priceVsReference: a.priceMultiplier / reference,
    };
  });
}

export interface LaunderOption {
  label: string;
  /** Argent sale blanchi par heure de jeu ($), plafonds compris. */
  dirtyPerHour: number;
  /** Argent propre obtenu par heure de jeu ($). */
  cleanPerHour: number;
}

/**
 * Blanchiment d'un revenu sale de `dirtyPerHour` $/h : banque seule, blanchisseur seul (plafonné),
 * et combinaison optimale (d'abord le lieu le moins cher, puis l'autre jusqu'à son plafond).
 */
export function launderReport(
  data: Pick<GameData, 'economy'>,
  dirtyPerHour: number,
): LaunderOption[] {
  const { bank, cellar } = data.economy.launder.venues;
  const capPerHour = (r: typeof bank) => (r.cap * 3600) / r.windowSeconds;
  const through = (r: typeof bank, dirty: number) => {
    const used = Math.min(dirty, capPerHour(r));
    return { used, clean: used * (1 - r.fee) };
  };
  const b = through(bank, dirtyPerHour);
  const c = through(cellar, dirtyPerHour);
  const [first, second] = cellar.fee <= bank.fee ? [cellar, bank] : [bank, cellar];
  const one = through(first, dirtyPerHour);
  const two = through(second, dirtyPerHour - one.used);
  return [
    { label: 'Banque seule', dirtyPerHour: b.used, cleanPerHour: b.clean },
    { label: 'Blanchisseur seul', dirtyPerHour: c.used, cleanPerHour: c.clean },
    {
      label: 'Combinaison optimale',
      dirtyPerHour: one.used + two.used,
      cleanPerHour: one.clean + two.clean,
    },
  ];
}

export interface StarterBagReport {
  pocketSlots: number;
  /** Cases occupées au départ : espèces (s'il y en a), kit minimal, graines du pacte. */
  slotsUsed: number;
  backpackPrice: number;
  /** Argent (propre + sale) restant après le kit minimal. */
  moneyAfterKit: number;
  /** Minutes de jeu de production (1 pot, sans lampe) avant de pouvoir payer le sac à dos. */
  minutesToBackpack: number;
}

/** Place dans les poches au départ et délai avant le sac à dos (depuis les JSON). */
export function starterBagReport(
  data: Pick<GameData, 'economy' | 'shops' | 'items'>,
): StarterBagReport {
  const { economy, shops, items } = data;
  const priceOf = (itemId: string) => {
    for (const shop of shops.values())
      for (const s of shop.shelves) if (s.itemId === itemId) return s.price;
    return Infinity;
  };
  const kit = ['pot', 'drying_rack', 'cutting_table'];
  // une case par objet du kit, une pour l'argent, une pour les graines (empilables)
  const seedId = economy.pact.seedItemId;
  const cashSlots = economy.startingMoney.dirty > 0 ? 1 : 0; // espèces : une case si on en a
  const slotsUsed =
    kit.length +
    cashSlots +
    Math.ceil(economy.pact.startSeeds / (items.get(seedId)?.stackMax ?? 1));
  // départ : argent propre (dépensable sans compte) + espèces éventuelles
  const start = economy.startingMoney.clean + economy.startingMoney.dirty;
  const moneyAfterKit = start - kit.reduce((s, id) => s + priceOf(id), 0);
  const backpackPrice = priceOf(economy.bag.backpackItemId);
  const perMinute = cycleReport(data, economy.strains[0]!.id).profitPerMinute;
  const missing = Math.max(0, backpackPrice - moneyAfterKit);
  return {
    pocketSlots: economy.bag.pocketSlots,
    slotsUsed,
    backpackPrice,
    moneyAfterKit,
    minutesToBackpack: missing / perMinute,
  };
}
