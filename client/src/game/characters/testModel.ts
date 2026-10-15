import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Tests uniquement : charge un .gltf de `client/public` sous Node (buffers en data URI).
 * FileLoader de three émet des `ProgressEvent`, absents de Node : version minimale.
 */
const g = globalThis as { ProgressEvent?: unknown };
g.ProgressEvent ??= class extends Event {
  readonly lengthComputable = false;
  readonly loaded: number;
  readonly total: number;
  constructor(type: string, init?: { loaded?: number; total?: number }) {
    super(type);
    this.loaded = init?.loaded ?? 0;
    this.total = init?.total ?? 0;
  }
};

export const PUBLIC_DIR = join(import.meta.dirname, '../../../public');

export function loadTestModel(model: string): Promise<GLTF> {
  return new GLTFLoader().parseAsync(readFileSync(join(PUBLIC_DIR, model), 'utf8'), '');
}
