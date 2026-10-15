/** Contrat réseau client <-> serveur. Le client n'envoie que des intentions. */
import type { LaunderVenue } from './schemas';

export const ROOM_NAME = 'narco';

/** Options envoyées à `create` / `joinById`. */
export interface JoinOptions {
  playerId: string;
  name: string;
  /** Code d'accès du serveur (si `NARCO_ACCESS_CODE` est défini). */
  accessCode?: string;
}

export const ClientMsg = {
  /** Position prédite par le client, validée par le serveur. */
  Move: 'move',
  /** Le joueur veut entrer dans un lieu (bouton ACTION). */
  Interact: 'interact',
  /** Action sur un poste d'intérieur (planter, arroser, sortir…). */
  Station: 'station',

  /** Commandes de debug (refusées si config.debug.commands est faux). */
  Debug: 'debug',
  /** Reposer 1 article du panier en rayon. */
  CartRemove: 'cartRemove',
  /** Manger / boire un objet du sac. */
  Use: 'use',
  /** Glisser-déposer d'une pile dans le sac. */
  InventoryMove: 'inventory.move',
  /** Bouton « Trier » : regroupe et range le sac. */
  InventorySort: 'inventory.sort',
  /** Meubles du labo : poser un objet du sac, déplacer, reprendre dans le sac. */
  FixturePlace: 'fixture.place',
  FixtureMove: 'fixture.move',
  FixturePickup: 'fixture.pickup',
  /** Vente de rue : demander une offre à un PNJ, l'accepter (quantité) ou la refuser. */
  SaleOpen: 'sale.open',
  SaleAccept: 'sale.accept',
  SaleDecline: 'sale.decline',
  /** Dialogue : choix d'une réponse sur le nœud courant (validé par le serveur). */
  DialogueChoose: 'dialogue.choose',
  /** Guichet : blanchir un montant d'argent sale. */
  BankLaunder: 'bank.launder',
} as const;

export const ServerMsg = {
  /** Le serveur a refusé/ajusté une position : le client se recale. */
  Correction: 'correction',
  /** Message court affiché au joueur (réponse à une interaction). */
  Notice: 'notice',
  /** Réponse à un glisser-déposer d'inventaire. */
  MoveResult: 'inventory.moveResult',
  /** Réponse à une intention sur un meuble (le mode placement se ferme si ok). */
  FixtureResult: 'fixture.result',
  /** Offre d'un PNJ réservée pour ce joueur (panneau de vente). */
  SaleOffer: 'sale.offer',
  /** Fin d'une offre (vente faite, refus, patience épuisée, joueur parti). */
  SaleClosed: 'sale.closed',
  /** Dialogue : nœud à afficher (null = fin de la conversation). */
  Dialogue: 'dialogue.node',
  /** Guichet : ouvrir le panneau de blanchiment (compte vérifié). */
  LaunderOpen: 'bank.launderOpen',
  /** Réponse à un blanchiment (le panneau se ferme si ok). */
  LaunderResult: 'bank.launderResult',
} as const;

/** Nom de l'événement serveur émis à chaque vente (pour le Heat et la police plus tard). */
export const SALE_COMPLETED = 'sale_completed';

export interface SaleCompletedEvent {
  playerId: string;
  npcId: string;
  qty: number;
  amount: number;
  x: number;
  z: number;
  /** Area du PNJ (`areas.json`) : la police et le conflit la liront. */
  area: string;
}

/** Événement serveur émis à chaque blanchiment (pour le Heat plus tard). */
export const LAUNDERED = 'laundered';

export interface LaunderedEvent {
  playerId: string;
  /** Somme sale retirée du sac. */
  dirty: number;
  /** Somme propre créditée sur le compte. */
  clean: number;
  /** Lieu du blanchiment et area de son entrée (lus par la Heat plus tard). */
  venue: LaunderVenue;
  area: string;
}

export interface DialogueChooseMessage {
  dialogueId: string;
  nodeId: string;
  choiceId: string;
}

export interface DialogueNodeMessage {
  dialogueId: string;
  /** Poste du personnage (comptoir du courtier…). */
  stationId: string;
  /** Nœud à afficher ; null = conversation terminée. */
  nodeId: string | null;
}

export interface LaunderOpenMessage {
  stationId: string;
  /** Lieu de blanchiment : règles (commission, plafond) et journal à afficher. */
  venue: LaunderVenue;
}

export interface BankLaunderMessage {
  requestId: number;
  stationId: string;
  amount: number;
}

export interface LaunderResultMessage {
  requestId: number;
  ok: boolean;
  text: string;
}

export interface MoveMessage {
  /** Zone dans laquelle la position a été calculée (les messages d'une ancienne zone sont ignorés). */
  zone: string;
  x: number;
  z: number;
  rotY: number;
  seq: number;
}

export interface CorrectionMessage {
  x: number;
  z: number;
  seq: number;
}

export interface InteractMessage {
  locationId: string;
}

export interface NoticeMessage {
  ok: boolean;
  text: string;
  locationId?: string;
}

/** Actions possibles sur un poste ; le serveur vérifie qu'elle correspond au type de poste. */
export const STATION_ACTIONS = [
  'plant',
  'water',
  'harvest',
  'fill',
  'hang',
  'collect',
  'cut',
  'exit',
  'take',
  'pay',
  /** Parler au personnage d'un poste `talk` (ouvre son dialogue). */
  'talk',
  /** Guichet : ouvrir le panneau de blanchiment (le serveur vérifie le compte). */
  'launder',
] as const;
export type StationAction = (typeof STATION_ACTIONS)[number];

export interface StationMessage {
  stationId: string;
  action: StationAction;
}

/** Inventaires manipulables (le stock commun reviendra avec la caisse posable). */
export type InventoryKind = 'bag';

export interface InventoryMoveMessage {
  requestId: number;
  from: { inv: InventoryKind; slot: number };
  to: { inv: InventoryKind; slot: number };
  /** Objet attendu dans le slot de départ : si le slot a changé entre-temps, refus. */
  itemId: string;
}

export interface MoveResultMessage {
  requestId: number;
  ok: boolean;
  text?: string;
}

/** Poser un objet posable du sac (position en m dans la pièce, rotation en quarts de tour). */
export interface FixturePlaceMessage {
  requestId: number;
  itemId: string;
  x: number;
  z: number;
  rot: number;
}

export interface FixtureMoveMessage {
  requestId: number;
  fixtureId: string;
  x: number;
  z: number;
  rot: number;
}

export interface FixturePickupMessage {
  requestId: number;
  fixtureId: string;
}

export interface FixtureResultMessage {
  requestId: number;
  ok: boolean;
  text: string;
  fixtureId?: string;
}

export interface SaleOpenMessage {
  npcId: string;
}

export interface SaleAcceptMessage {
  npcId: string;
  qty: number;
}

export interface SaleOfferMessage {
  npcId: string;
  name: string;
  pouchId: string;
  /** Pochons qu'il veut (au plus). */
  maxQty: number;
  unitPrice: number;
  /** Fin de sa patience (temps de jeu, ms). */
  expiresAt: number;
  /** Area du PNJ et multiplicateur de prix déjà appliqué à `unitPrice`. */
  area: string;
  priceMultiplier: number;
}

export interface SaleClosedMessage {
  npcId: string;
}

export interface UseMessage {
  slot: number;
}

export interface CartRemoveMessage {
  stationId: string;
}

export type DebugMessage =
  | { cmd: 'give'; itemId: string; qty: number }
  | { cmd: 'timeScale'; scale: number }
  | { cmd: 'restock' }
  | { cmd: 'money'; amount: number }
  | { cmd: 'vitals'; mode: 'fill' | 'empty' }
  | { cmd: 'survivalScale'; scale: number }
  | { cmd: 'equipLab' }
  | { cmd: 'clearLab' }
  | { cmd: 'spawnBuyer' }
  | { cmd: 'openAccount' }
  | { cmd: 'setClean'; amount: number }
  | { cmd: 'giveClean'; amount: number }
  | { cmd: 'teleport'; areaId: string }
  | { cmd: 'priceMultiplier'; areaId: string; value: number }
  | { cmd: 'resetLaunderCap'; venue?: LaunderVenue }
  | { cmd: 'launderFee'; venue: LaunderVenue; value: number }
  | { cmd: 'teleportTrapdoor' };

export const MAX_NAME_LENGTH = 16;

export function sanitizeName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const name = raw
    // eslint-disable-next-line no-control-regex -- retire volontairement les caractères de contrôle
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return name || fallback;
}
