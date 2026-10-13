import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';

const PORT = Number(process.env.PORT ?? 2567);
const HOST = process.env.HOST ?? '0.0.0.0';

const gameServer = new Server({ transport: new WebSocketTransport() });

await gameServer.listen(PORT, HOST);
console.log(`[narco] serveur Colyseus sur ws://${HOST}:${PORT}`);
