/**
 * Équilibrage de la production et de la vente de rue, calculé depuis les JSON (`npm run balance`).
 * Rien n'est en dur : changer un prix, une durée ou un profil de PNJ change le rapport.
 */
import { cycleReport, gameData, starterKitCost, survivalCostReport } from '@narco/shared';

const { economy, npcs, config } = gameData;
const lamp = economy.lab.lamp;
const lampRateMax = 1 / (1 - lamp.maxLamps * lamp.growReductionPerLamp);
const kit = starterKitCost(gameData);

console.log(
  `Kit de départ (pot + étendoir + table + ${economy.lab.starterKitSeeds} graines) : ${kit} $`,
);
console.log(`Argent sale de départ : ${economy.startingMoney.dirty} $\n`);

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
const pouchesPerMin = (config.npc.count * perNpcVisit) / avgCooldownMin;
const base = economy.strains[0]!;
console.log(
  `\nDébouché de la rue : ~${pouchesPerMin.toFixed(1)} pochons/min de jeu au mieux`,
  `(${config.npc.count} PNJ, ${perNpcVisit.toFixed(2)} pochon par passage, cooldown moyen ${(avgCooldownMin * 60).toFixed(0)} s)`,
  `soit ~${(pouchesPerMin * base.pouchSellPrice).toFixed(0)} $/min si on trouve chaque acheteur.`,
);

// Survie payée en argent propre : ce que coûte la nourriture, et ce qu'il faut vendre puis blanchir.
const food = survivalCostReport(gameData);
console.log(
  `\nSurvie en argent propre : ${food.perMinute.toFixed(2)} $/min de jeu, ${food.perHour.toFixed(0)} $/h`,
  `(faim ${food.hungerPointPrice.toFixed(3)} $/pt, soif ${food.thirstPointPrice.toFixed(3)} $/pt).`,
  `\nÀ couvrir : ${(food.perHour * food.dirtyPerClean).toFixed(0)} $ sales/h blanchis`,
  `(commission ${economy.bank.fee * 100} %) → ${Math.ceil(food.pouchesPerHour)} pochons ${base.name}/h`,
  `(${(food.pouchesPerHour / 60).toFixed(2)}/min).`,
);
