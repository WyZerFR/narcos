import type { RenderParams } from '@narco/shared';

/** Une ombre blob : centre au sol et rayon (m). */
export interface Blob {
  x: number;
  z: number;
  r: number;
}

export type BlobKind = keyof RenderParams['blob']['radius'];

/** Pièces de décor instanciées qui portent une ombre blob, par clé de kit (Decor.tsx). */
export const BLOB_KIT_KINDS: Readonly<Record<string, BlobKind>> = {
  cars: 'car',
  policeCars: 'car',
  trees: 'tree',
  palms: 'tree',
  bins: 'prop',
  crates: 'prop',
  cartons: 'prop',
  containers: 'car',
};

/** Ombres fixes du décor (voitures garées, arbres, props), publiées par Decor au montage. */
let staticBlobs: readonly Blob[] = [];
let staticVersion = 0;
const listeners = new Set<() => void>();

export function setStaticBlobs(list: readonly Blob[]): void {
  staticBlobs = list;
  staticVersion++;
  for (const fn of listeners) fn();
}

export function getStaticBlobs(): { list: readonly Blob[]; version: number } {
  return { list: staticBlobs, version: staticVersion };
}

export function onStaticBlobs(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Positions affichées des joueurs distants (interpolées), écrites par RemotePlayer. */
export const remoteActorPositions = new Map<string, { x: number; z: number }>();

/** Ombres blob d'un kit de décor : rayon selon le type, échelle de l'instance comprise. */
export function kitBlobs(
  key: string,
  items: readonly { x: number; z: number; scale?: number }[],
  radius: RenderParams['blob']['radius'],
): Blob[] {
  const kind = BLOB_KIT_KINDS[key];
  if (!kind) return [];
  return items.map((it) => ({ x: it.x, z: it.z, r: radius[kind] * (it.scale ?? 1) }));
}
