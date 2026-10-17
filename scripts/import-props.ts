/**
 * Import des décors 3D (`npm run models:import`) : lit `scripts/props-selection.json`, prend
 * chaque modèle retenu dans le pack brut (`public/maps/3D/`, hors dépôt) et écrit une version
 * allégée dans `client/public/models/<catégorie>/<id>.glb`, puis génère `shared/data/props.json`.
 *
 * Allègement : toutes les primitives fusionnées en une seule (1 draw call), texture remplacée par
 * des couleurs de sommets (une couleur par face, prise au centre de ses UV), aucune texture
 * restante ; simplification (SimplifyModifier de three) si le modèle dépasse le budget de
 * triangles de sa catégorie, refusée en dessous de `minKeepRatio` (modèle écarté).
 * Boîte englobante, décalage d'origine et emprise de collision calculés ici.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { BufferAttribute, BufferGeometry, Matrix4, Quaternion, Vector3 } from 'three';
import { SimplifyModifier } from 'three/examples/jsm/modifiers/SimplifyModifier.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  gameData,
  type Prop,
  type PropCategory,
  type PropCollision,
  type PropsFile,
} from '../shared/src/index';

const ROOT = resolve(import.meta.dirname, '..');

interface Selected {
  id: string;
  source: string;
  category: PropCategory;
  /** Hauteur réelle (m) ; absente : hauteur de la boîte × `scale` (1 par défaut). */
  height?: number;
  scale?: number;
  rotationY: number;
  /**
   * Origine du fichier gardée (pas de recentrage de la boîte) : groupe de props calé sur son
   * bâtiment, lampadaire à crosse posé sur son mât. Collision `none` obligatoire.
   */
  keepOrigin?: boolean;
  cuttable?: boolean;
  keepColors?: boolean;
  tint?: Prop['tint'];
  collision?: 'rect' | 'circle' | 'none';
  tags: string[];
  /** Dossier source propre au modèle (relatif à la racine), sinon `sourceDir`. */
  sourceDir?: string;
  /** Dossier de sortie (`models/<folder>/`), sinon la catégorie. */
  folder?: string;
  family?: Prop['family'];
  footprint?: Prop['footprint'];
  /** Nœud racine à importer seul (fichier à plusieurs props), sinon toute la scène. */
  node?: string;
  /** Nœuds racines écartés (dalles de sol d'un fichier de props) quand toute la scène est prise. */
  exclude?: string[];
  /** Nœuds racines retenus (nom exact ou préfixe suivi de `.` ou `_`) : part d'un groupe de props. */
  nodes?: string[];
  /** Carrosserie (nom de matériau contenant ce texte) : blanche, attribut `_PAINT`, teinte d'instance. */
  paint?: string;
}

interface Selection {
  tint: Record<PropCategory, { brightness: number; saturation: number }>;
  emissive: PropsFile['emissive'];
  sourceDir: string;
  license: string;
  minKeepRatio: number;
  /** Vitres semi-transparentes (`alphaMode` BLEND) rendues opaques de cette couleur (sRGB). */
  glass: string;
  models: Selected[];
}

interface Accessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  normalized?: boolean;
}

interface Gltf {
  nodes?: {
    mesh?: number;
    children?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
    matrix?: number[];
    name?: string;
  }[];
  scenes?: { nodes?: number[] }[];
  scene?: number;
  meshes?: {
    primitives: { attributes: Record<string, number>; indices?: number; material?: number }[];
  }[];
  accessors?: Accessor[];
  bufferViews?: { byteOffset?: number; byteLength: number; byteStride?: number }[];
  materials?: {
    pbrMetallicRoughness?: {
      baseColorFactor?: number[];
      baseColorTexture?: { index: number };
    };
    emissiveFactor?: number[];
    name?: string;
    alphaMode?: string;
  }[];
  textures?: { source?: number }[];
  images?: { uri?: string; bufferView?: number }[];
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function parseGlb(file: string): { json: Gltf; bin: Buffer } {
  const buf = readFileSync(file);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8')) as Gltf;
  return { json, bin: buf.subarray(20 + jsonLen + 8) };
}

/** Valeurs d'un accesseur en flottants (entiers normalisés ramenés à [0, 1] ou [-1, 1]). */
function readAccessor(json: Gltf, bin: Buffer, index: number): { data: number[]; size: number } {
  const acc = json.accessors![index]!;
  const size = COMPONENTS[acc.type]!;
  const view = json.bufferViews![acc.bufferView!]!;
  const bytes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[acc.componentType]!;
  const stride = view.byteStride ?? bytes * size;
  const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const data: number[] = [];
  for (let i = 0; i < acc.count; i++)
    for (let k = 0; k < size; k++) {
      const o = base + i * stride + k * bytes;
      let v: number;
      switch (acc.componentType) {
        case 5126:
          v = bin.readFloatLE(o);
          break;
        case 5125:
          v = bin.readUInt32LE(o);
          break;
        case 5123:
          v = bin.readUInt16LE(o);
          if (acc.normalized) v /= 65535;
          break;
        case 5122:
          v = bin.readInt16LE(o);
          if (acc.normalized) v = Math.max(v / 32767, -1);
          break;
        case 5121:
          v = bin.readUInt8(o);
          if (acc.normalized) v /= 255;
          break;
        default:
          v = bin.readInt8(o);
          if (acc.normalized) v = Math.max(v / 127, -1);
      }
      data.push(v);
    }
  return { data, size };
}

/** PNG 8 bits RGB ou RGBA non entrelacé → pixels RGBA. */
function decodePng(bytes: Buffer): { w: number; h: number; rgba: Uint8Array } {
  const w = bytes.readUInt32BE(16);
  const h = bytes.readUInt32BE(20);
  const depth = bytes[24];
  const colorType = bytes[25];
  if (depth !== 8 || ![2, 3, 6].includes(colorType ?? -1) || bytes[28] !== 0)
    throw new Error(`PNG non géré (profondeur ${depth}, type ${colorType})`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  let palette: Buffer | null = null;
  const idat: Buffer[] = [];
  for (let o = 8; o < bytes.length;) {
    const len = bytes.readUInt32BE(o);
    const type = bytes.toString('ascii', o + 4, o + 8);
    if (type === 'IDAT') idat.push(bytes.subarray(o + 8, o + 8 + len));
    if (type === 'PLTE') palette = bytes.subarray(o + 8, o + 8 + len);
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = new Uint8Array(w * h * channels);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const cur = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= channels ? out[y * stride + x - channels]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels]! : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = (cur + pred) & 0xff;
    }
  }
  if (channels === 4) return { w, h, rgba: out };
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (palette) rgba.set(palette.subarray(out[i]! * 3, out[i]! * 3 + 3), i * 4);
    else rgba.set(out.subarray(i * 3, i * 3 + 3), i * 4);
    rgba[i * 4 + 3] = 255;
  }
  return { w, h, rgba };
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

interface Part {
  geometry: BufferGeometry; // position (monde) + uv éventuel, indexée
  factor: [number, number, number];
  texture: { w: number; h: number; rgba: Uint8Array } | null;
  /** Fichier de la texture (atlas du pack), null si intégrée ou absente. */
  texturePath: string | null;
  /** Matériau émissif (néon) : couleur émise, null sinon. */
  emissive: [number, number, number] | null;
  /** Carrosserie teinte par instance (`_PAINT`). */
  paint: boolean;
  /** Vitre semi-transparente, rendue opaque (`selection.glass`). */
  glass: boolean;
}

/** Primitives triangulées de la scène, positions dans le repère de la scène. */
function partsOf(file: string, s: Selected): Part[] {
  const { node, exclude = [], nodes, paint } = s;
  const wanted = (name: string) =>
    node !== undefined
      ? name === node
      : nodes
        ? nodes.some((n) => name === n || name.startsWith(`${n}.`) || name.startsWith(`${n}_`))
        : !exclude.includes(name);
  const { json, bin } = parseGlb(file);
  const images = new Map<number, Part['texture']>();
  const imagePath = (index: number): string | null => {
    const uri = json.images![index]!.uri;
    return uri && !uri.startsWith('data:') ? join(dirname(file), decodeURIComponent(uri)) : null;
  };
  const imageOf = (index: number): Part['texture'] => {
    if (!images.has(index)) {
      const im = json.images![index]!;
      let bytes: Buffer;
      if (im.uri) bytes = readFileSync(join(dirname(file), decodeURIComponent(im.uri)));
      else {
        const v = json.bufferViews![im.bufferView!]!;
        bytes = bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
      }
      images.set(index, decodePng(bytes));
    }
    return images.get(index)!;
  };
  const parts: Part[] = [];
  const visit = (i: number, parent: Matrix4) => {
    const node = json.nodes![i]!;
    const local = new Matrix4();
    if (node.matrix) local.fromArray(node.matrix);
    else
      local.compose(
        new Vector3(...((node.translation ?? [0, 0, 0]) as [number, number, number])),
        new Quaternion(...((node.rotation ?? [0, 0, 0, 1]) as [number, number, number, number])),
        new Vector3(...((node.scale ?? [1, 1, 1]) as [number, number, number])),
      );
    const world = parent.clone().multiply(local);
    for (const p of node.mesh !== undefined ? json.meshes![node.mesh]!.primitives : []) {
      const g = new BufferGeometry();
      const pos = readAccessor(json, bin, p.attributes.POSITION!);
      g.setAttribute('position', new BufferAttribute(new Float32Array(pos.data), 3));
      g.applyMatrix4(world);
      const mat = p.material !== undefined ? json.materials?.[p.material] : undefined;
      const pbr = mat?.pbrMetallicRoughness;
      const tex = pbr?.baseColorTexture;
      const source =
        tex && p.attributes.TEXCOORD_0 !== undefined ? json.textures![tex.index]!.source! : null;
      const texture = source !== null ? imageOf(source) : null;
      const texturePath = source !== null ? imagePath(source) : null;
      if (texture) {
        const uv = readAccessor(json, bin, p.attributes.TEXCOORD_0!);
        g.setAttribute('uv', new BufferAttribute(new Float32Array(uv.data), 2));
      }
      const index =
        p.indices !== undefined
          ? readAccessor(json, bin, p.indices).data
          : [...Array(pos.data.length / 3).keys()];
      g.setIndex(index);
      const f = pbr?.baseColorFactor ?? [1, 1, 1, 1];
      const e = mat?.emissiveFactor;
      const emissive: Part['emissive'] =
        e && e.some((c) => c > 0) ? [e[0] ?? 0, e[1] ?? 0, e[2] ?? 0] : null;
      parts.push({
        geometry: g,
        factor: [f[0]!, f[1]!, f[2]!],
        texture,
        texturePath,
        emissive,
        paint: paint !== undefined && (mat?.name ?? '').includes(paint),
        glass: mat?.alphaMode === 'BLEND',
      });
    }
    for (const c of node.children ?? []) visit(c, world);
  };
  const roots = (json.scenes?.[json.scene ?? 0]?.nodes ?? [0]).filter((r) =>
    wanted(json.nodes![r]!.name ?? ''),
  );
  if (roots.length === 0) throw new Error(`${file} : nœud "${node ?? nodes}" introuvable`);
  for (const r of roots) visit(r, new Matrix4());
  return parts;
}

const triangles = (g: BufferGeometry) =>
  (g.index ? g.index.count : g.attributes.position!.count) / 3;

/** Simplifie une partie texturée jusqu'à `target` triangles (null si trop de perte). */
async function simplify(
  g: BufferGeometry,
  target: number,
  minKeep: number,
): Promise<BufferGeometry | null> {
  const merged = mergeVertices(g);
  const start = triangles(merged);
  const modifier = new SimplifyModifier();
  // dichotomie sur le nombre de sommets retirés : le moins possible sous la cible
  let lo = 0;
  let hi = merged.attributes.position!.count;
  let best: BufferGeometry | null = null;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const out = await modifier.modify(merged, mid);
    if (triangles(out) <= target) {
      best = out;
      hi = mid;
    } else lo = mid;
  }
  return best && triangles(best) / start >= minKeep ? best : null;
}

/**
 * Positions non indexées, couleurs RGBA (0-255, linéaires) et UV. Modèle entièrement texturé
 * par un atlas en fichier : UV gardées, couleur = facteur du matériau (texture d'origine au
 * rendu). Sinon : une couleur par face (texture échantillonnée au centre de ses UV, ou facteur).
 */
function bake(
  parts: Part[],
  glass: [number, number, number],
): {
  positions: Float32Array;
  colors: Uint8Array;
  uvs: Float32Array | null;
  emit: Float32Array | null;
  paint: Float32Array | null;
  luminance: number;
} {
  let lumSum = 0;
  let faces = 0;
  const keepUv = parts.every((p) => p.texturePath && p.geometry.attributes.uv);
  const anyEmissive = parts.some((p) => p.emissive);
  const anyPaint = parts.some((p) => p.paint);
  const pos: number[] = [];
  const col: number[] = [];
  const uvs: number[] = [];
  const emit: number[] = [];
  const paints: number[] = [];
  for (const { geometry, factor, texture, emissive, paint, glass: isGlass } of parts) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    const p = g.attributes.position!;
    const uv = g.attributes.uv;
    for (let v = 0; v < p.count; v += 3) {
      let rgb = [...factor];
      if (texture && uv) {
        const u = (uv.getX(v) + uv.getX(v + 1) + uv.getX(v + 2)) / 3;
        const w = (uv.getY(v) + uv.getY(v + 1) + uv.getY(v + 2)) / 3;
        const fract = (x: number) => x - Math.floor(x);
        const x = Math.min(texture.w - 1, Math.floor(fract(u) * texture.w));
        const y = Math.min(texture.h - 1, Math.floor(fract(w) * texture.h));
        const o = (y * texture.w + x) * 4;
        rgb = rgb.map((c, k) => c * toLinear(texture.rgba[o + k]! / 255));
      }
      lumSum += 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
      faces++;
      // texture gardée : la couleur de sommet reste le facteur du matériau
      if (keepUv) rgb = [...factor];
      // néon : la couleur de sommet est la couleur émise
      if (emissive) rgb = [...emissive];
      // vitrine semi-transparente : opaque sombre bleutée ; carrosserie : blanche (teinte d'instance)
      if (isGlass) rgb = [...glass];
      if (paint) rgb = [1, 1, 1];
      for (let k = 0; k < 3; k++) {
        pos.push(p.getX(v + k), p.getY(v + k), p.getZ(v + k));
        col.push(...rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255)), 255);
        if (keepUv && uv) uvs.push(uv.getX(v + k), uv.getY(v + k));
        if (anyEmissive) emit.push(emissive ? 1 : 0);
        if (anyPaint) paints.push(paint ? 1 : 0);
      }
    }
  }
  return {
    positions: new Float32Array(pos),
    colors: new Uint8Array(col),
    uvs: keepUv ? new Float32Array(uvs) : null,
    emit: anyEmissive ? new Float32Array(emit) : null,
    paint: anyPaint ? new Float32Array(paints) : null,
    luminance: faces ? lumSum / faces : 0,
  };
}

/**
 * GLB minimal : un nœud, un maillage, une primitive (POSITION, COLOR_0, TEXCOORD_0 si texturé,
 * `_EMISSIVE` si néons : 1 = face émissive, `_PAINT` si carrosserie : 1 = teinte d'instance),
 * un matériau. La texture n'est pas intégrée :
 * l'atlas du pack est un fichier partagé.
 */
function writeGlb(
  file: string,
  name: string,
  positions: Float32Array,
  colors: Uint8Array,
  uvs: Float32Array | null,
  extras: Record<string, Float32Array | null>,
) {
  const n = positions.length / 3;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, positions[i * 3 + k]!);
      max[k] = Math.max(max[k]!, positions[i * 3 + k]!);
    }
  const attributes: Record<string, number> = { POSITION: 0, COLOR_0: 1 };
  const accessors: object[] = [
    { bufferView: 0, componentType: 5126, count: n, type: 'VEC3', min, max },
    { bufferView: 1, componentType: 5121, normalized: true, count: n, type: 'VEC4' },
  ];
  const bufferViews: object[] = [
    { buffer: 0, byteOffset: 0, byteLength: n * 12, target: 34962 },
    { buffer: 0, byteOffset: n * 12, byteLength: n * 4, target: 34962 },
  ];
  const chunks = [Buffer.from(positions.buffer), Buffer.from(colors.buffer)];
  if (uvs) {
    attributes.TEXCOORD_0 = 2;
    accessors.push({ bufferView: 2, componentType: 5126, count: n, type: 'VEC2' });
    bufferViews.push({ buffer: 0, byteOffset: n * 16, byteLength: n * 8, target: 34962 });
    chunks.push(Buffer.from(uvs.buffer));
  }
  let offset = n * (uvs ? 24 : 16);
  for (const [attr, values] of Object.entries(extras)) {
    if (!values) continue;
    attributes[attr] = accessors.length;
    accessors.push({
      bufferView: bufferViews.length,
      componentType: 5126,
      count: n,
      type: 'SCALAR',
    });
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: n * 4, target: 34962 });
    chunks.push(Buffer.from(values.buffer));
    offset += n * 4;
  }
  const json = {
    asset: { version: '2.0', generator: 'narco import-props' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [{ name, primitives: [{ attributes, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 } }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  };
  const pad = (b: Buffer, fill: number) =>
    Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
  const jsonChunk = pad(Buffer.from(JSON.stringify(json)), 0x20);
  const binChunk = pad(Buffer.concat(chunks), 0);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  const chunk = (b: Buffer, type: number) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(b.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, b]);
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    Buffer.concat([header, chunk(jsonChunk, 0x4e4f534a), chunk(binChunk, 0x004e4942)]),
  );
  return { min, max };
}

/** Atlas d'un pack copié une fois : `models/textures/<pack>.png` (côté ≤ maxTextureSize). */
function copyTexture(src: string, pack: string, maxSize: number): string {
  const bytes = readFileSync(src);
  const size = Math.max(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  if (size > maxSize) throw new Error(`${src} : ${size}px, au-delà de ${maxSize}px`);
  const slug = pack
    .toLowerCase()
    .replace(/^(glb|gltf) format /, '')
    .replace(/[^a-z0-9]+/g, '-');
  const path = `models/textures/${slug}.png`;
  mkdirSync(join(ROOT, 'client/public/models/textures'), { recursive: true });
  writeFileSync(join(ROOT, 'client/public', path), bytes);
  return path;
}

const selection = JSON.parse(
  readFileSync(join(ROOT, 'scripts/props-selection.json'), 'utf8'),
) as Selection;
const { budget, vegetationCollisionRatio } = gameData.config.props;
const round = (x: number) => Math.round(x * 1000) / 1000;
const glassHex = selection.glass.replace('#', '');
const glassColor = [0, 2, 4].map((i) => toLinear(parseInt(glassHex.slice(i, i + 2), 16) / 255)) as [
  number,
  number,
  number,
];
const props: Prop[] = [];
const rejected: string[] = [];

for (const s of selection.models) {
  const parts = partsOf(join(ROOT, s.sourceDir ?? selection.sourceDir, s.source), s);
  const before = parts.reduce((t, p) => t + triangles(p.geometry), 0);
  const max = budget[s.category].maxTriangles;
  let kept = parts;
  if (before > max) {
    if (parts.some((p) => !p.texture)) {
      rejected.push(
        `${s.id} : ${before} triangles, couleurs par matériau (simplification non gérée)`,
      );
      continue;
    }
    // une seule texture partagée : fusion avant simplification
    const merged = new BufferGeometry();
    const all = parts.map((p) => p.geometry.toNonIndexed());
    const cat = (name: string, size: number) => {
      const out = new Float32Array(all.reduce((n, g) => n + g.attributes[name]!.count * size, 0));
      let o = 0;
      for (const g of all) {
        out.set(g.attributes[name]!.array as Float32Array, o);
        o += g.attributes[name]!.count * size;
      }
      return new BufferAttribute(out, size);
    };
    merged.setAttribute('position', cat('position', 3));
    merged.setAttribute('uv', cat('uv', 2));
    const simple = await simplify(merged, Math.floor(max * 0.98), selection.minKeepRatio);
    if (!simple) {
      rejected.push(
        `${s.id} : ${before} triangles, simplification sous ${selection.minKeepRatio * 100} %`,
      );
      continue;
    }
    kept = [{ ...parts[0]!, geometry: simple }];
  }
  const { positions, colors, uvs, emit, paint, luminance } = bake(kept, glassColor);
  const model = `models/${s.folder ?? s.category}/${s.id}.glb`;
  const b = writeGlb(join(ROOT, 'client/public', model), s.id, positions, colors, uvs, {
    _EMISSIVE: emit,
    _PAINT: paint,
  });
  const texture = uvs
    ? copyTexture(
        kept[0]!.texturePath!,
        basename(dirname(s.source)),
        budget[s.category].maxTextureSize,
      )
    : null;
  if (s.keepOrigin && s.collision !== 'none') {
    rejected.push(`${s.id} : keepOrigin sans collision "none"`);
    continue;
  }
  const height = round(s.height ?? (b.max[1]! - b.min[1]!) * (s.scale ?? 1));
  const scale = height / (b.max[1]! - b.min[1]!);
  const turned = Math.abs(Math.round(s.rotationY / 90)) % 2 === 1;
  const w = (turned ? b.max[2]! - b.min[2]! : b.max[0]! - b.min[0]!) * scale;
  const d = (turned ? b.max[0]! - b.min[0]! : b.max[2]! - b.min[2]!) * scale;
  const shape = s.collision ?? (s.category === 'vegetation' ? 'circle' : 'rect');
  const collision: PropCollision | null =
    shape === 'none'
      ? null
      : shape === 'circle'
        ? { shape: 'circle', r: round((vegetationCollisionRatio * Math.min(w, d)) / 2) }
        : { shape: 'rect', w: round(w), d: round(d) };
  props.push({
    id: s.id,
    category: s.category,
    model,
    source: s.source,
    height,
    rotationY: s.rotationY,
    offset: s.keepOrigin
      ? [0, round(-b.min[1]!), 0]
      : [
          round(-(b.min[0]! + b.max[0]!) / 2),
          round(-b.min[1]!),
          round(-(b.min[2]! + b.max[2]!) / 2),
        ],
    bounds: {
      min: b.min.map(round) as [number, number, number],
      max: b.max.map(round) as [number, number, number],
    },
    collision,
    keepColors: s.keepColors ?? true,
    ...(s.tint ? { tint: s.tint } : {}),
    cuttable: s.cuttable ?? false,
    ...(texture ? { texture } : {}),
    ...(s.folder ? { folder: s.folder } : {}),
    ...(s.family ? { family: s.family } : {}),
    ...(s.footprint ? { footprint: s.footprint } : {}),
    ...(emit ? { emissive: true } : {}),
    ...(paint ? { paint: true } : {}),
    ...(s.keepOrigin ? { keepOrigin: true } : {}),
    triangles: positions.length / 9,
    luminance: round(luminance),
    tags: s.tags,
  });
  console.log(
    `✓ ${model} : ${before} → ${positions.length / 9} triangles, ${parts.length} primitive(s) → 1`,
  );
}
for (const r of rejected) console.log(`✗ écarté ${r}`);
writeFileSync(
  join(ROOT, 'shared/data/props.json'),
  JSON.stringify(
    { license: selection.license, tint: selection.tint, emissive: selection.emissive, props },
    null,
    2,
  ) + '\n',
);
console.log(
  `${props.length} modèle(s) retenu(s), ${rejected.length} écarté(s) → shared/data/props.json`,
);
