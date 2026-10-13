import { gameData } from '@narco/shared';
import { createGameServer } from './app';

const PORT = Number(process.env.NARCO_SERVER_PORT ?? 2567);
const HOST = process.env.NARCO_SERVER_HOST ?? '0.0.0.0';

function logDataSummary(): void {
  const { economy, items, locations, zones } = gameData;
  const base = economy.strains[0]!;
  console.log(
    `[narco] données chargées : ${items.size} items, ${locations.size} lieux, ${zones.size} zone(s) | ` +
      `pochon ${base.name} ${base.pouchSellPrice} $ | taxe El Jefe ${economy.elJefe.salesTaxRate * 100} % | ` +
      `dealer ${economy.dealer.weeklyCost} $/semaine`,
  );
}

logDataSummary();
const gameServer = createGameServer();
await gameServer.listen(PORT, HOST);
console.log(`[narco] serveur Colyseus sur ws://${HOST}:${PORT}`);
