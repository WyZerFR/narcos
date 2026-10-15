/**
 * Équilibrage de la production et de la vente de rue, calculé depuis les JSON (`npm run balance`).
 * Rien n'est en dur : changer un prix, une durée ou un profil de PNJ change le rapport.
 */
import {
  areaSalesReport,
  areaSpot,
  cellIndex,
  createNavGrid,
  cycleReport,
  distancesFrom,
  gameData,
  interactionPoint,
  launderReport,
  obstaclesFrom,
  starterBagReport,
  starterKitCost,
  survivalCostReport,
} from '@narco/shared';

const { economy, npcs, config } = gameData;
const lamp = economy.lab.lamp;
const lampRateMax = 1 / (1 - lamp.maxLamps * lamp.growReductionPerLamp);
const kit = starterKitCost(gameData);

console.log(
  `Kit de départ (pot + étendoir + table + ${economy.lab.starterKitSeeds} graines) : ${kit} $`,
);
console.log(
  `Départ : ${economy.startingMoney.clean} $ propres (sans compte), ${economy.startingMoney.dirty} $ sales ; graines : pacte d'El Jefe (${economy.pact.startSeeds}, gratuites), plus en vente\n`,
);

for (const strain of economy.strains) {
  for (const rate of [1, lampRateMax]) {
    const r = cycleReport(gameData, strain.id, rate);
    if (!Number.isFinite(r.seedCost)) {
      console.log(`${strain.name} (acte ${strain.unlockAct}) : graine pas encore en vente.`);
      break;
    }
    console.log(
      `${strain.name} (acte ${strain.unlockAct}), ${rate === 1 ? 'sans lampe' : `${lamp.maxLamps} lampes`} :`,
      `${r.pouches} pochons × ${r.avgPrice} $ − graine ${r.seedCost} $ = ${r.profit} $ par cycle`,
      `de ${Math.round(r.cycleSeconds)} s → ${r.profitPerMinute.toFixed(1)} $/min de jeu par pot`,
      `(kit remboursé en ${(kit / r.profit).toFixed(1)} cycles)`,
    );
  }
}

// Débouché : combien de pochons la rue absorbe-t-elle par minute de jeu (borne haute) ?
const totalWeight = npcs.profiles.reduce((s, p) => s + p.weight, 0);
const perNpcVisit = npcs.profiles.reduce(
  (s, p) => s + (p.weight / totalWeight) * p.interestChance * ((p.qty[0] + p.qty[1]) / 2),
  0,
);
const avgCooldownMin = (config.npc.cooldownSeconds[0] + config.npc.cooldownSeconds[1]) / 2 / 60;
const npcTotal = [...gameData.areas.values()].reduce((n, a) => n + a.npcCount, 0);
const pouchesPerMin = (npcTotal * perNpcVisit) / avgCooldownMin;
const base = economy.strains[0]!;
console.log(
  `\nDébouché de la rue : ~${pouchesPerMin.toFixed(1)} pochons/min de jeu au mieux`,
  `(${npcTotal} PNJ, ${perNpcVisit.toFixed(2)} pochon par passage, cooldown moyen ${(avgCooldownMin * 60).toFixed(0)} s)`,
  `soit ~${(pouchesPerMin * base.pouchSellPrice).toFixed(0)} $/min si on trouve chaque acheteur.`,
);

// Survie payée en argent propre : ce que coûte la nourriture, et ce qu'il faut vendre puis blanchir.
const food = survivalCostReport(gameData);
console.log(
  `\nSurvie en argent propre : ${food.perMinute.toFixed(2)} $/min de jeu, ${food.perHour.toFixed(0)} $/h`,
  `(faim ${food.hungerPointPrice.toFixed(3)} $/pt, soif ${food.thirstPointPrice.toFixed(3)} $/pt).`,
  `\nÀ couvrir : ${(food.perHour * food.dirtyPerClean).toFixed(0)} $ sales/h blanchis`,
  `(commission banque ${economy.launder.venues.bank.fee * 100} %) → ${Math.ceil(food.pouchesPerHour)} pochons ${base.name}/h`,
  `(${(food.pouchesPerHour / 60).toFixed(2)}/min).`,
);

// Vente par area : PNJ, multiplicateur de prix, débouché ; comparaison avec l'area de référence.
const ref = gameData.marketReference;
console.log(`\nRevenu par area (au mieux, chaque acheteur trouvé ; référence ${ref.name}) :`);
const sales = areaSalesReport(gameData);
const refSales = sales.find((r) => r.areaId === ref.id);
for (const r of sales)
  console.log(
    `  ${r.name} : ${r.npcCount} PNJ, prix ×${r.priceMultiplier} (${r.avgPrice.toFixed(1)} $/pochon),`,
    `~${r.pouchesPerMinute.toFixed(1)} pochons/min → ~${r.revenuePerMinute.toFixed(0)} $/min`,
    `(danger ${gameData.areas.get(r.areaId)!.dangerLevel}/5)`,
    refSales && refSales.revenuePerMinute > 0 && r.npcCount > 0 && r.areaId !== ref.id
      ? `(référence : ×${(r.revenuePerMinute / refSales.revenuePerMinute).toFixed(2)} en $/min, ×${r.priceVsReference.toFixed(2)} par pochon)`
      : '',
  );

// Trajets à pied depuis le point de départ (grille de navigation, vitesse de marche).
const grid = createNavGrid(
  config.world.bounds,
  obstaclesFrom(gameData),
  config.world.playerRadius,
  config.npc.navCellSize,
);
const fromSpawn = distancesFrom(grid, config.players.spawn);
const trip = (label: string, p: { x: number; z: number }) => {
  const m = fromSpawn[cellIndex(grid, p)]!;
  console.log(
    Number.isFinite(m)
      ? `  ${label} : ${m.toFixed(0)} m, ${(m / config.movement.walkSpeed).toFixed(1)} s en marchant, ${(m / config.movement.runSpeed).toFixed(1)} s en courant`
      : `  ${label} : inaccessible`,
  );
};
console.log('\nTrajets à pied depuis le départ, vers chaque lieu :');
for (const loc of gameData.locations.values()) trip(loc.name, interactionPoint(loc));
console.log("Vers chaque area (point d'arrivée, devant le portail si verrouillée) :");
const streetObstacles = obstaclesFrom(gameData);
for (const a of gameData.areas.values()) {
  const p = areaSpot(gameData, a.id, streetObstacles);
  if (p) trip(`${a.name}${a.locked ? ' (verrouillée)' : ''}`, p);
}

// Blanchiment : revenu sale de toute la rue (débouché max des areas) passé par la banque, le
// blanchisseur de la cave, ou les deux (le moins cher d'abord).
const dirtyPerHour = sales.reduce((s, r) => s + r.revenuePerMinute, 0) * 60;
console.log(`\nBlanchiment de ~${dirtyPerHour.toFixed(0)} $ sales/h (débouché max des areas) :`);
for (const o of launderReport(gameData, dirtyPerHour))
  console.log(
    `  ${o.label} : ${o.dirtyPerHour.toFixed(0)} $ sales/h blanchis → ${o.cleanPerHour.toFixed(0)} $ propres/h`,
  );
const trapLoc = [...gameData.quartiers.values()]
  .map((q) => q.cellarLocationId && gameData.locations.get(q.cellarLocationId))
  .find((l) => l);
if (trapLoc) {
  const m = fromSpawn[cellIndex(grid, interactionPoint(trapLoc))]!;
  console.log(
    `  Trajet départ → trappe de la cave : ${m.toFixed(0)} m, ${(m / config.movement.walkSpeed).toFixed(1)} s en marchant`,
  );
}

// Capacité du sac au départ : poches occupées par le kit et délai avant le sac à dos.
const bagStart = starterBagReport(gameData);
console.log(
  `\nPoches : ${bagStart.slotsUsed}/${bagStart.pocketSlots} cases au départ (espèces s'il y en a, pot, étendoir, table, graines du pacte).`,
  `Sac à dos ${bagStart.backpackPrice} $ (${economy.bag.backpackSlots} cases) :`,
  bagStart.minutesToBackpack === 0
    ? `achetable dès le départ (reste ${bagStart.moneyAfterKit} $ après le kit).`
    : `achetable après ~${bagStart.minutesToBackpack.toFixed(1)} min de production (1 pot).`,
);
