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
  /** Transfert sac ↔ stock commun (près de la caisse). */
  Transfer: 'transfer',
  /** Commandes de debug (refusées si config.debug.commands est faux). */
  Debug: 'debug',
  /** Reposer 1 article du panier en rayon. */
  CartRemove: 'cartRemove',
  /** Manger / boire un objet du sac. */
  Use: 'use',
  /** Glisser-déposer d'une pile (sac / stock). */
  InventoryMove: 'inventory.move',
  /** Installer / démonter du mobilier sur un emplacement du labo. */
  Fixture: 'fixture',
} as const;

export const ServerMsg = {
  /** Le serveur a refusé/ajusté une position : le client se recale. */
  Correction: 'correction',
  /** Message court affiché au joueur (réponse à une interaction). */
  Notice: 'notice',
  /** Réponse à un glisser-déposer d'inventaire. */
  MoveResult: 'inventory.moveResult',
} as const;

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
  /** Le client ouvre ce panneau (ex. caisse du stock). */
  open?: 'stock';
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
  'open',
  'exit',
  'take',
  'pay',
] as const;
export type StationAction = (typeof STATION_ACTIONS)[number];

export interface StationMessage {
  stationId: string;
  action: StationAction;
}

export interface TransferMessage {
  from: 'bag' | 'stock';
  slot: number;
  qty: number;
}

export type InventoryKind = 'bag' | 'stock';

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

export interface UseMessage {
  slot: number;
}

export interface CartRemoveMessage {
  stationId: string;
}

export type DebugMessage =
  | { cmd: 'give'; itemId: string; qty: number }
  | { cmd: 'clearStock' }
  | { cmd: 'timeScale'; scale: number }
  | { cmd: 'restock' }
  | { cmd: 'money'; amount: number }
  | { cmd: 'vitals'; mode: 'fill' | 'empty' }
  | { cmd: 'survivalScale'; scale: number }
  | { cmd: 'equipLab' }
  | { cmd: 'clearLab' };

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
