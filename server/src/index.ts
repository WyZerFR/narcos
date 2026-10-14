import { matchMaker } from '@colyseus/core';
import { ROOM_NAME, gameData } from '@narco/shared';
import { createGameServer } from './app';
import { DEFAULT_SNAPSHOT_FILE, readSnapshotFile, writeSnapshotFile } from './persistence';
import { liveRooms } from './rooms/NarcoRoom';

const PORT = Number(process.env.NARCO_SERVER_PORT ?? 2567);
const HOST = process.env.NARCO_SERVER_HOST ?? '0.0.0.0';

function logDataSummary(): void {
  const { economy, items, locations, zones, interiors } = gameData;
  const base = economy.strains[0]!;
  console.log(
    `[narco] données chargées : ${items.size} items, ${locations.size} lieux, ${zones.size} zone(s), ` +
      `${interiors.size} intérieur(s) | pochon ${base.name} ${base.pouchSellPrice} $ | ` +
      `taxe El Jefe ${economy.elJefe.salesTaxRate * 100} % | dealer ${economy.dealer.weeklyCost} $/semaine`,
  );
}

function saveAll(): void {
  try {
    writeSnapshotFile(
      DEFAULT_SNAPSHOT_FILE,
      [...liveRooms].map((r) => r.snapshot()),
    );
  } catch (err) {
    console.warn('[narco] sauvegarde impossible :', (err as Error).message);
  }
}

logDataSummary();
const gameServer = createGameServer();
await gameServer.listen(PORT, HOST);
console.log(`[narco] serveur Colyseus sur ws://${HOST}:${PORT}`);

// Les parties sauvegardées reviennent avec leur code : les clients s'y reconnectent seuls.
for (const snap of readSnapshotFile(DEFAULT_SNAPSHOT_FILE)) {
  await matchMaker.createRoom(ROOM_NAME, { restore: snap });
}

setInterval(saveAll, gameData.config.persistence.snapshotSeconds * 1000);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    saveAll();
    process.exit(0);
  });
}
