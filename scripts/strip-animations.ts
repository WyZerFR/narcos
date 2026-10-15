/**
 * Retire les animations d'un .gltf à buffer unique en data URI
 * (`npm run models:strip -- src.gltf dest.gltf`) : les skins du pack « perso 1 »
 * partagent un squelette, leurs clips viennent d'un seul fichier
 * (`config.characters.animationLibrary`) ; chaque skin ne garde que sa géométrie.
 */
import { readFileSync, writeFileSync } from 'node:fs';

interface View {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  target?: number;
}
interface Primitive {
  attributes: Record<string, number>;
  indices?: number;
  targets?: Record<string, number>[];
  [key: string]: unknown;
}
export interface StripGltf {
  buffers: { uri?: string; byteLength: number }[];
  bufferViews: View[];
  accessors: { bufferView?: number; [key: string]: unknown }[];
  meshes?: { primitives: Primitive[]; [key: string]: unknown }[];
  skins?: { inverseBindMatrices?: number; [key: string]: unknown }[];
  animations?: unknown[];
  [key: string]: unknown;
}

/** Applique `f` à chaque référence d'accesseur hors animations (attributs, index, skins). */
function eachAccessorRef(json: StripGltf, f: (i: number) => number): void {
  const map = (rec: Record<string, number>) => {
    for (const k of Object.keys(rec)) rec[k] = f(rec[k]!);
  };
  for (const mesh of json.meshes ?? [])
    for (const p of mesh.primitives) {
      map(p.attributes);
      if (p.indices !== undefined) p.indices = f(p.indices);
      p.targets?.forEach(map);
    }
  for (const skin of json.skins ?? [])
    if (skin.inverseBindMatrices !== undefined)
      skin.inverseBindMatrices = f(skin.inverseBindMatrices);
}

export function stripAnimations(source: StripGltf): StripGltf {
  const json = structuredClone(source);
  const uri = json.buffers[0]?.uri ?? '';
  if (json.buffers.length !== 1 || !uri.startsWith('data:'))
    throw new Error('buffer unique en data URI attendu');
  const bin = Buffer.from(uri.split(',')[1] ?? '', 'base64');
  const used = new Set<number>();
  eachAccessorRef(json, (i) => (used.add(i), i));
  const keepAcc = [...used].sort((a, b) => a - b);
  const accMap = new Map(keepAcc.map((a, n) => [a, n]));
  const viewMap = new Map<number, number>();
  const views: View[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const vi of [...new Set(keepAcc.map((i) => json.accessors[i]!.bufferView!))].sort(
    (a, b) => a - b,
  )) {
    const v = json.bufferViews[vi]!;
    const pad = (4 - (offset % 4)) % 4;
    chunks.push(Buffer.alloc(pad));
    offset += pad;
    const start = v.byteOffset ?? 0;
    chunks.push(bin.subarray(start, start + v.byteLength));
    viewMap.set(vi, views.length);
    views.push({ ...v, buffer: 0, byteOffset: offset });
    offset += v.byteLength;
  }
  json.accessors = keepAcc.map((a) => {
    const acc = json.accessors[a]!;
    return { ...acc, bufferView: viewMap.get(acc.bufferView!) };
  });
  eachAccessorRef(json, (i) => accMap.get(i)!);
  const data = Buffer.concat(chunks);
  json.bufferViews = views;
  json.buffers = [
    {
      byteLength: data.length,
      uri: `data:application/octet-stream;base64,${data.toString('base64')}`,
    },
  ];
  delete json.animations;
  return json;
}

if (process.argv[1]?.endsWith('strip-animations.ts')) {
  const [src, dest] = process.argv.slice(2);
  if (!src || !dest) throw new Error('usage : strip-animations <src.gltf> <dest.gltf>');
  const json = JSON.parse(readFileSync(src, 'utf8')) as StripGltf;
  writeFileSync(dest, JSON.stringify(stripAnimations(json)));
}
