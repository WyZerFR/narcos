/**
 * Tests uniquement, à importer en premier : environnement navigateur minimal pour monter la scène
 * sous Node avec @react-three/test-renderer, et lecture des modèles de `client/public` sur disque.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const g = globalThis as Record<string, unknown>;
g.location ??= new URL('http://localhost/');
g.IS_REACT_ACT_ENVIRONMENT = true;
const store = new Map<string, string>();
g.localStorage ??= {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
const events = { addEventListener: () => undefined, removeEventListener: () => undefined };
g.window ??= Object.assign(globalThis, events);
const ctx2d = {
  createRadialGradient: () => ({ addColorStop: () => undefined }),
  fillRect: () => undefined,
  fillStyle: '',
};
const doc = {
  ...events,
  visibilityState: 'visible',
  createElement: () => ({ ...events, width: 0, height: 0, getContext: () => ctx2d, style: {} }),
};
// le moteur de test simule son canvas WebGL seulement sans `document` : on le lui cache
if (!Object.getOwnPropertyDescriptor(globalThis, 'document')?.get)
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    get: () => (new Error().stack?.includes('test-renderer') ? undefined : doc),
  });

const PUBLIC_DIR = join(import.meta.dirname, '../../public');

/** Lecteur de modèles sur disque (remplace `fetch` sous Node). */
export async function readPublic(path: string): Promise<ArrayBuffer> {
  const buf = readFileSync(join(PUBLIC_DIR, path));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
