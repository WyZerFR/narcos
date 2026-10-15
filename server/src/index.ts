import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { matchMaker } from '@colyseus/core';
import { ROOM_NAME, gameData } from '@narco/shared';
import { createGameServer } from './app';
import { readSnapshotFile, snapshotFile, writeSnapshotFile } from './persistence';
import { accessCode, debugEnabled, serverHost, serverPort, staticDir } from './env';
import { liveRooms } from './rooms/NarcoRoom';

const PORT = serverPort();
const HOST = serverHost();
const SNAPSHOT_FILE = snapshotFile();

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
      SNAPSHOT_FILE,
      [...liveRooms].map((r) => r.snapshot()),
    );
  } catch (err) {
    console.warn('[narco] sauvegarde impossible :', (err as Error).message);
  }
}

logDataSummary();
const gameServer = createGameServer();
await gameServer.listen(PORT, HOST);
console.log(
  `[narco] serveur sur http://${HOST}:${PORT} (client : ${staticDir()}, sauvegardes : ${SNAPSHOT_FILE}, ` +
    `code d'accès : ${accessCode() ? 'oui' : 'non'}, debug : ${debugEnabled() ? 'oui' : 'non'})`,
);
// dossier des sauvegardes créé dès le démarrage (volume monté vide)
mkdirSync(dirname(SNAPSHOT_FILE), { recursive: true });

// Les parties sauvegardées reviennent avec leur code : les clients s'y reconnectent seuls.
for (const snap of readSnapshotFile(SNAPSHOT_FILE)) {
  await matchMaker.createRoom(ROOM_NAME, { restore: snap });
}

setInterval(saveAll, gameData.config.persistence.snapshotSeconds * 1000);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    saveAll();
    process.exit(0);
  });
}
