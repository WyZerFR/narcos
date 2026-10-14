import { ColyseusTestServer } from '@colyseus/testing';
import { createGameServer } from '../src/app';

/**
 * Démarre un serveur de test sur un port dédié. `boot()` de @colyseus/testing ignore le port
 * quand on lui passe un `Server` ; or chaque fichier de test tourne en parallèle.
 */
export async function bootOn(port: number): Promise<ColyseusTestServer> {
  const server = createGameServer();
  await server.listen(port);
  return new ColyseusTestServer(server);
}
