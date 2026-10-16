import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, Profiler, type ReactNode } from 'react';
import ReactThreeTestRenderer from '@react-three/test-renderer';

// modules du client lus au chargement (réglages, connexion) : environnement navigateur minimal
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.location ??= new URL('http://localhost/');
  const store = new Map<string, string>();
  g.localStorage ??= {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const events = { addEventListener: () => undefined, removeEventListener: () => undefined };
  g.window ??= Object.assign(globalThis, events);
  // halo des lampadaires : texture radiale dessinée dans un canvas 2D (jamais envoyée au GPU ici)
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
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    get: () => (new Error().stack?.includes('test-renderer') ? undefined : doc),
  });
});
import { gameData, STREET } from '@narco/shared';
import type { GameRoom } from '../net/connection';
import { City } from './city/City';
import { BlobShadows } from './BlobShadows';
import { Ambience } from './Ambience';
import { localPlayer } from './localPlayer';
import { getStaticBlobs } from './blobRegistry';

/**
 * Non-régression de la boucle de rendu (#185 « Maximum update depth exceeded ») : la scène de la
 * rue (ville, décor, halos, ombres blob, ambiance du thème) montée avec les vraies données pendant
 * 120 ticks simulés, nombre de rendus par composant borné.
 */
const TICKS = 120;
/** Rendus tolérés par composant : montage, préchauffage, chargement des areas, aucun par tick. */
const MAX_RENDERS = 12;

const spawn = gameData.config.players.spawn;
const room = {
  state: {
    players: new Map([
      ['moi', { id: 'moi', x: spawn.x, z: spawn.z, zone: STREET, connected: true }],
      ['autre', { id: 'autre', x: spawn.x + 2, z: spawn.z, zone: STREET, connected: true }],
    ]),
    npcs: new Map(),
  },
} as unknown as GameRoom;

const renders = new Map<string, number>();
const counted = (id: string, child: ReactNode) =>
  createElement(
    Profiler,
    { id, onRender: () => renders.set(id, (renders.get(id) ?? 0) + 1) },
    child,
  );

afterEach(() => {
  renders.clear();
  vi.restoreAllMocks();
});

describe('boucle de rendu de la scène', () => {
  it('le registre des ombres blob renvoie un instantané stable (useSyncExternalStore)', () => {
    expect(getStaticBlobs()).toBe(getStaticBlobs());
  });

  it(`${TICKS} ticks : aucune boucle de mises à jour, rendus bornés par composant`, async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    Object.assign(localPlayer, { initialized: true, x: spawn.x, z: spawn.z, zone: STREET });

    let scene: Awaited<ReturnType<typeof ReactThreeTestRenderer.create>> | null = null;
    try {
      const mounted = await ReactThreeTestRenderer.create(
        createElement(
          'group',
          null,
          counted('Ambience', createElement(Ambience, { themeId: 'cartel' })),
          counted(
            'City',
            createElement(City, {
              glowBoost: 1,
              lockVersion: 0,
              themeId: 'cartel',
              shadows: false,
            }),
          ),
          counted('BlobShadows', createElement(BlobShadows, { room, zone: STREET })),
        ),
      );
      scene = mounted;
      await ReactThreeTestRenderer.act(async () => {
        await mounted.advanceFrames(TICKS, 1 / 60);
      });
    } catch (err) {
      errors.push(String((err as Error).message ?? err));
    }

    // message complet non minifié et avertissement React qui nomme le composant fautif
    const loops = errors.filter((e) => /Maximum update depth|getSnapshot should be cached/.test(e));
    expect(loops, loops.join('\n')).toEqual([]);
    for (const [id, n] of renders)
      expect(n, `${id} : ${n} rendus`).toBeLessThanOrEqual(MAX_RENDERS);
    expect(renders.get('BlobShadows')).toBeGreaterThan(0);
    await scene?.unmount();
  }, 60_000);
});

describe('error boundary des canvas', () => {
  it('nomme le composant fautif depuis la pile React', async () => {
    const { faultyComponent } = await import('../ui/CanvasBoundary');
    expect(
      faultyComponent('\n    at BlobShadows (http://x/BlobShadows.tsx:40)\n    at group'),
    ).toBe('BlobShadows');
    expect(faultyComponent('\n    in City\n    in World')).toBe('City');
    expect(faultyComponent(undefined)).toBeNull();
  });
});
