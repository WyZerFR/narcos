import {
  checkLaunder,
  count,
  DIRTY_CASH,
  gameData,
  remove,
  shiftLog,
  type LaunderEntry as LogEntry,
  type Station,
} from '@narco/shared';
import { readInventory, writeInventory } from './stateSync';
import { LaunderEntry, type GameState, type Player } from './schema';

/**
 * Banque côté serveur : guichets (blanchiment), plafond sur fenêtre glissante. La règle est
 * `checkLaunder` (shared) ; ici on lit et écrit l'état (sac, solde, journal).
 */

const { economy, items } = gameData;
const RULES = economy.bank;

export interface BankResult {
  ok: boolean;
  text: string;
  dirty?: number;
  clean?: number;
}

const refuse = (text: string): BankResult => ({ ok: false, text });

function readLog(player: Player): LogEntry[] {
  return player.launderLog.map((e) => ({ at: e.at, amount: e.amount }));
}

function writeLog(player: Player, log: readonly LogEntry[]): void {
  player.launderLog.clear();
  player.launderLog.push(...log.map((e) => Object.assign(new LaunderEntry(), e)));
}

/** Guichet de la pièce où se trouve le joueur, ou un message de refus. */
export function tellerOf(player: Player, stationId: string): Station | string {
  const st = gameData.interiors.get(player.zone)?.stations.find((s) => s.id === stationId);
  return st?.kind === 'teller' ? st : "Ce guichet n'est pas ici.";
}

/** « Blanchir » au guichet : il faut un compte ouvert (le panneau s'ouvre ensuite). */
export function openTeller(player: Player): BankResult {
  if (!player.hasAccount) return refuse("Ouvrez d'abord un compte.");
  return { ok: true, text: '' };
}

/**
 * Blanchit `amount` $ sales du sac : commission retenue, net crédité sur le compte.
 * Zone, guichet et proximité sont vérifiés par l'appelant (`isNear`).
 */
export function launder(
  player: Player,
  req: { stationId: string; amount: number },
  now: number,
  isNear: (st: Station) => boolean,
): BankResult {
  const teller = tellerOf(player, req.stationId);
  if (typeof teller === 'string') return refuse(teller);
  if (!isNear(teller)) return refuse(`Trop loin : ${teller.label}`);
  const bag = readInventory(player.bag);
  const check = checkLaunder(RULES, {
    hasAccount: player.hasAccount,
    dirty: count(bag, DIRTY_CASH),
    amount: req.amount,
    log: readLog(player),
    now,
  });
  if (!check.ok) return refuse(check.message);
  const r = remove(bag, DIRTY_CASH, req.amount, items);
  if (!r.ok) return refuse(r.message);
  writeInventory(player.bag, r.inv);
  player.cleanBalance += check.net;
  writeLog(player, check.log);
  return {
    ok: true,
    text: `${req.amount} $ sales → ${check.net} $ propres sur votre compte (commission ${check.commission} $).`,
    dirty: req.amount,
    clean: check.net,
  };
}

/** Temps passé sans joueur connecté : les fenêtres du plafond sont gelées (décalées). */
export function freezeLaunderWindows(state: GameState, deltaMs: number): void {
  if (deltaMs <= 0) return;
  state.players.forEach((p) => {
    if (p.launderLog.length > 0) writeLog(p, shiftLog(readLog(p), deltaMs));
  });
}

/** Debug : remet le plafond à zéro. */
export function resetLaunderCap(player: Player): void {
  player.launderLog.clear();
}
