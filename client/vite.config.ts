import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

const SERVER_PORT = Number(process.env.SERVER_PORT ?? 2567);

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'https' ? [basicSsl()] : [])],
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
