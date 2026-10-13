import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

const SERVER_PORT = Number(process.env.NARCO_SERVER_PORT ?? 2567);

/**
 * Dev uniquement : POST /__shot (corps = data URL d'image) enregistre une capture du canvas
 * dans `.shots/` à la racine du dépôt (ignoré par git). Sert à vérifier le rendu.
 */
function debugShots(): Plugin {
  const dir = resolve(__dirname, '..', '.shots');
  return {
    name: 'narco-debug-shots',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__shot', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const match = /^data:image\/(png|jpeg);base64,(.+)$/.exec(body);
          if (!match) {
            res.statusCode = 400;
            res.end('data URL attendue');
            return;
          }
          const name = (new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? 'shot')
            .replace(/[^a-z0-9_-]/gi, '')
            .slice(0, 40);
          mkdirSync(dir, { recursive: true });
          const file = resolve(dir, `${name || 'shot'}.${match[1] === 'png' ? 'png' : 'jpg'}`);
          writeFileSync(file, Buffer.from(match[2]!, 'base64'));
          res.end(file);
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), debugShots(), ...(mode === 'https' ? [basicSsl()] : [])],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: {
      // Une seule origine pour le client : HTTP(S) de matchmaking + WebSocket passent par Vite.
      '/colyseus': {
        target: `http://localhost:${SERVER_PORT}`,
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/colyseus/, ''),
      },
    },
  },
  preview: { host: '0.0.0.0', port: 4173 },
}));
