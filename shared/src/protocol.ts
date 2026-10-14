/** Contrat réseau client <-> serveur. Le client n'envoie que des intentions. */

export const ROOM_NAME = 'narco';

/** Options envoyées à `create` / `joinById`. */
export interface JoinOptions {
  playerId: string;
  name: string;
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
  /** Installer / démonter du mobilier sur un emplacement du labo. */
  Fixture: 'fixture',
  /** Vente de rue : demander une offre à un PNJ, l'accepter (quantité) ou la refuser. */
  SaleOpen: 'sale.open',
  SaleAccept: 'sale.accept',
  SaleDecline: 'sale.decline',
} as const;

export const ServerMsg = {
  /** Le serveur a refusé/ajusté une position : le client se recale. */
  Correction: 'correction',
  /** Message court affiché au joueur (réponse à une interaction). */
  Notice: 'notice',
  /** Réponse à un glisser-déposer d'inventaire. */
  MoveResult: 'inventory.moveResult',
  /** Offre d'un PNJ réservée pour ce joueur (panneau de vente). */
  SaleOffer: 'sale.offer',
  /** Fin d'une offre (vente faite, refus, patience épuisée, joueur parti). */
  SaleClosed: 'sale.closed',
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

export interface FixtureMessage {
  fixtureId: string;
  action: 'install' | 'uninstall';
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
  | { cmd: 'spawnBuyer' };

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
