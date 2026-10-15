import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { ROOM_NAME } from '@narco/shared';
import { NarcoRoom } from './rooms/NarcoRoom';
import { accessCode, staticDir } from './env';

/**
 * Serveur HTTP + WebSocket sur un seul port : matchmaking et WebSocket Colyseus (préfixe
 * `/colyseus` côté client, comme le proxy Vite en dev), `/health`, `/info`, et le client
 * compilé (`client/dist`) en statique. Utilisé par `index.ts` et par les tests.
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res: ServerResponse, status: number, body: string, type = 'text/plain'): void {
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(body);
}

/** Fichier du client à servir (null si absent ou hors du dossier). */
function resolveStatic(root: string, pathname: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const file = normalize(join(root, rel));
  if (file !== root && !file.startsWith(root + sep)) return null;
  if (existsSync(file) && statSync(file).isFile()) return file;
  // routes de l'app (pas d'extension) : index.html
  if (!extname(rel)) {
    const index = join(root, 'index.html');
    return existsSync(index) ? index : null;
  }
  return null;
}

function serveFile(res: ServerResponse, file: string): void {
  const name = file.split(sep).pop() ?? '';
  // index.html et le service worker toujours revalidés : chaque déploiement est récupéré
  const immutable = file.includes(`${sep}assets${sep}`);
  const cache =
    name === 'index.html' || name === 'sw.js' || name.endsWith('.webmanifest')
      ? 'no-cache'
      : immutable
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600';
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': cache,
  });
  createReadStream(file).pipe(res);
}

export function handleHttp(req: IncomingMessage, res: ServerResponse, root: string): void {
  const url = new URL(req.url ?? '/', 'http://local');
  const path = url.pathname.replace(/^\/colyseus(?=\/|$)/, '') || '/';
  if (path === '/health') return send(res, 200, 'ok');
  if (path === '/info')
    return send(
      res,
      200,
      JSON.stringify({ accessRequired: accessCode() !== null }),
      'application/json',
    );
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Méthode refusée');
  const file = resolveStatic(root, path);
  if (!file) return send(res, 404, 'Introuvable');
  serveFile(res, file);
}

/** Construit le serveur de jeu ; `root` = dossier du client compilé. */
export function createGameServer(root = staticDir()): Server {
  const http = createServer((req, res) => handleHttp(req, res, root));
  const server = new Server({ transport: new WebSocketTransport({ server: http }) });
  server.define(ROOM_NAME, NarcoRoom);
  return server;
}
