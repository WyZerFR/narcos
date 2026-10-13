import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { ROOM_NAME } from '@narco/shared';
import { NarcoRoom } from './rooms/NarcoRoom';

/** Construit le serveur de jeu (utilisé par `index.ts` et par les tests). */
export function createGameServer(): Server {
  const server = new Server({ transport: new WebSocketTransport() });
  server.define(ROOM_NAME, NarcoRoom);
  return server;
}
