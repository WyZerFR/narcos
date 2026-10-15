import {
  areaAt,
  checkLaunder,
  count,
  DIRTY_CASH,
  gameData,
  remove,
  shiftLog,
  type LaunderEntry as LogEntry,
  type LaunderVenue,
  type Station,
} from '@narco/shared';
import { readInventory, writeInventory } from './stateSync';
import { LaunderEntry, type GameState, type Player } from './schema';

/**
 * Blanchiment côté serveur, par lieu (`economy.launder.venues`) : guichets de la banque, bureau
 * du blanchisseur de la cave. Chaque lieu a son plafond glissant et son journal. La règle est
 * `checkLaunder` (shared) ; ici on lit et écrit l'état (sac, solde, journaux).
 */

const { economy, items } = gameData;
const VENUES = economy.launder.venues;
const AREAS = [...gameData.areas.values()];

export interface BankResult {
  ok: boolean;
  text: string;
  dirty?: number;
  clean?: number;
  venue?: LaunderVenue;
}

const refuse = (text: string): BankResult => ({ ok: false, text });

/** Journal du plafond d'un lieu (un tableau d'état par lieu). */
function logOf(player: Player, venue: LaunderVenue) {
  return venue === 'bank' ? player.launderLog : player.cellarLaunderLog;
}

function readLog(player: Player, venue: LaunderVenue): LogEntry[] {
  return logOf(player, venue).map((e) => ({ at: e.at, amount: e.amount }));
}

function writeLog(player: Player, venue: LaunderVenue, log: readonly LogEntry[]): void {
  const target = logOf(player, venue);
  target.clear();
  target.push(...log.map((e) => Object.assign(new LaunderEntry(), e)));
}

/** Lieu de blanchiment d'un poste : guichet (banque) ou poste qui déclare `launderVenue`. */
export function venueOf(st: Station): LaunderVenue | null {
  if (st.launderVenue) return st.launderVenue;
  return st.kind === 'teller' ? 'bank' : null;
}

/** Poste de blanchiment de la pièce où se trouve le joueur, ou un message de refus. */
export function tellerOf(player: Player, stationId: string): Station | string {
  const st = gameData.interiors.get(player.zone)?.stations.find((s) => s.id === stationId);
  return st && venueOf(st) ? st : "Ce guichet n'est pas ici.";
}

/** Area du lieu (celle de la porte d'entrée de l'intérieur), pour l'événement `laundered`. */
export function venueArea(zoneId: string): string {
  const entrance = gameData.interiors.get(zoneId)?.entranceLocationId;
  const loc = entrance ? gameData.locations.get(entrance) : undefined;
  return (loc && areaAt(AREAS, loc.position)?.id) ?? '';
}

/** Ouvrir le panneau d'un lieu : compte exigé si le lieu le demande. */
export function openTeller(player: Player, venue: LaunderVenue): BankResult {
  const rules = VENUES[venue];
  if (rules.requireAccount && !player.hasAccount) return refuse(rules.noAccountText);
  return { ok: true, text: '', venue };
}

/**
 * Blanchit `amount` $ sales du sac au poste `stationId` : commission du lieu retenue, net
 * crédité sur le compte. Zone, poste et proximité sont vérifiés ici (`isNear` de la room).
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
  const venue = venueOf(teller)!;
  const bag = readInventory(player.bag);
  const check = checkLaunder(VENUES[venue], {
    hasAccount: player.hasAccount,
    dirty: count(bag, DIRTY_CASH),
    amount: req.amount,
    log: readLog(player, venue),
    now,
  });
  if (!check.ok) return refuse(check.message);
  const r = remove(bag, DIRTY_CASH, req.amount, items);
  if (!r.ok) return refuse(r.message);
  writeInventory(player.bag, r.inv);
  player.cleanBalance += check.net;
  writeLog(player, venue, check.log);
  return {
    ok: true,
    text: `${req.amount} $ sales → ${check.net} $ propres sur votre compte (commission ${check.commission} $).`,
    dirty: req.amount,
    clean: check.net,
    venue,
  };
}

/** Temps passé sans joueur connecté : les fenêtres de tous les lieux sont gelées (décalées). */
export function freezeLaunderWindows(state: GameState, deltaMs: number): void {
  if (deltaMs <= 0) return;
  state.players.forEach((p) => {
    for (const venue of ['bank', 'cellar'] as const)
      if (logOf(p, venue).length > 0) writeLog(p, venue, shiftLog(readLog(p, venue), deltaMs));
  });
}

/** Debug : remet à zéro le plafond d'un lieu (tous par défaut). */
export function resetLaunderCap(player: Player, venue?: LaunderVenue): void {
  for (const v of ['bank', 'cellar'] as const) if (!venue || v === venue) logOf(player, v).clear();
}
