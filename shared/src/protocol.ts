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
} as const;

export const ServerMsg = {
  /** Le serveur a refusé/ajusté une position : le client se recale. */
  Correction: 'correction',
} as const;

export interface MoveMessage {
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
