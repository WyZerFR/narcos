import { timingSafeEqual, createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gameData } from '@narco/shared';

/**
 * Réglages d'environnement du serveur (lus à l'appel : les tests peuvent les changer).
 * - `PORT` (imposé par Railway / Fly), repli `NARCO_SERVER_PORT`, puis 2567 ;
 * - `NARCO_DATA_DIR` : dossier des sauvegardes (défaut server/.data) ;
 * - `NARCO_ACCESS_CODE` : code demandé au lobby (optionnel) ;
 * - `NODE_ENV=production` coupe les commandes debug, sauf `NARCO_DEBUG=1`.
 */

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function serverPort(): number {
  return Number(process.env.PORT ?? process.env.NARCO_SERVER_PORT ?? 2567);
}

export function serverHost(): string {
  return process.env.NARCO_SERVER_HOST ?? '0.0.0.0';
}

export function dataDir(): string {
  return resolve(process.env.NARCO_DATA_DIR ?? resolve(SERVER_DIR, '.data'));
}

/** Client compilé (`npm run build`), servi en statique par le serveur de production. */
export function staticDir(): string {
  return resolve(process.env.NARCO_STATIC_DIR ?? resolve(SERVER_DIR, '..', 'client', 'dist'));
}

export function accessCode(): string | null {
  const code = process.env.NARCO_ACCESS_CODE?.trim();
  return code ? code : null;
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Le code fourni ouvre-t-il l'accès ? (toujours vrai sans code configuré) */
export function accessGranted(given: unknown): boolean {
  const expected = accessCode();
  if (!expected) return true;
  if (typeof given !== 'string') return false;
  return timingSafeEqual(digest(given.trim()), digest(expected));
}

export function debugEnabled(): boolean {
  if (!gameData.config.debug.commands) return false;
  return process.env.NODE_ENV !== 'production' || process.env.NARCO_DEBUG === '1';
}
