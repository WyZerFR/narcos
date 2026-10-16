/**
 * Budget d'un modèle glTF (JSON déjà lu, pure) : triangles, draw calls après la fusion faite par
 * le client (une SkinnedMesh par skin), plus grande texture, animations.
 */

export interface GltfJson {
  meshes?: {
    primitives?: { indices?: number; mode?: number; attributes: Record<string, number> }[];
  }[];
  nodes?: {
    mesh?: number;
    skin?: number;
    children?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
    matrix?: number[];
  }[];
  scenes?: { nodes?: number[] }[];
  scene?: number;
  accessors?: { count: number; min?: number[]; max?: number[] }[];
  images?: { uri?: string; bufferView?: number }[];
  animations?: { name?: string }[];
}

export interface ModelReport {
  triangles: number;
  primitives: number;
  /** Draw calls par instance après fusion des parties d'un même squelette. */
  drawCalls: number;
  /** Plus grand côté de texture (px), 0 sans texture. */
  maxTexture: number;
  /** Nombre d'images (textures) du fichier. */
  textures: number;
  animations: string[];
  /** Boîte englobante des maillages dans le repère de la scène (unités du fichier). */
  bounds: Box3Like;
}

export interface Box3Like {
  min: [number, number, number];
  max: [number, number, number];
}

/** Où est l'origine du modèle : au pied (base à y = 0), au centre, ou ailleurs. */
export type ModelOrigin = 'pied' | 'centre' | 'décalée';

export interface ModelBudget {
  maxTriangles: number;
  maxDrawCalls: number;
  maxTextureSize: number;
  maxFileMB: number;
}

/** Largeur × hauteur d'un PNG ou d'un JPEG (null si format inconnu). */
export function imageSize(bytes: Uint8Array): { w: number; h: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47)
    return { w: view.getUint32(16), h: view.getUint32(20) };
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xc2)
      return { w: view.getUint16(i + 7), h: view.getUint16(i + 5) };
    i += 2 + view.getUint16(i + 2);
  }
  return null;
}

/** `imageBytes(index)` fournit les octets de l'image `index` (data URI, GLB ou fichier). */
export function inspectGltf(
  json: GltfJson,
  imageBytes: (index: number) => Uint8Array | null = () => null,
): ModelReport {
  let triangles = 0;
  let primitives = 0;
  const accessors = json.accessors ?? [];
  for (const mesh of json.meshes ?? [])
    for (const p of mesh.primitives ?? []) {
      primitives++;
      const acc = accessors[p.indices ?? p.attributes.POSITION ?? -1];
      if ((p.mode ?? 4) === 4 && acc) triangles += acc.count / 3;
    }
  const skins = new Set<number>();
  let drawCalls = 0;
  for (const node of json.nodes ?? []) {
    if (node.mesh === undefined) continue;
    if (node.skin !== undefined) skins.add(node.skin);
    else drawCalls += json.meshes?.[node.mesh]?.primitives?.length ?? 0;
  }
  drawCalls += skins.size;
  let maxTexture = 0;
  const images = json.images ?? [];
  images.forEach((_, i) => {
    const bytes = imageBytes(i);
    const s = bytes ? imageSize(bytes) : null;
    if (s) maxTexture = Math.max(maxTexture, s.w, s.h);
  });
  return {
    triangles: Math.round(triangles),
    primitives,
    drawCalls,
    maxTexture,
    textures: images.length,
    animations: (json.animations ?? []).map((a) => a.name ?? ''),
    bounds: sceneBounds(json),
  };
}

type Mat4 = number[];

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) out[c * 4 + r] = out[c * 4 + r]! + a[k * 4 + r]! * b[c * 4 + k]!;
  return out;
}

/** Matrice locale d'un nœud glTF (colonne majeure) : `matrix` ou T · R · S. */
function localMatrix(node: NonNullable<GltfJson['nodes']>[number]): Mat4 {
  if (node.matrix?.length === 16) return node.matrix;
  const [tx = 0, ty = 0, tz = 0] = node.translation ?? [];
  const [x = 0, y = 0, z = 0, w = 1] = node.rotation ?? [];
  const [sx = 1, sy = 1, sz = 1] = node.scale ?? [];
  // prettier-ignore
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

/** Boîte englobante des maillages de la scène (min/max des accesseurs POSITION transformés). */
export function sceneBounds(json: GltfJson): Box3Like {
  const nodes = json.nodes ?? [];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const visit = (i: number, parent: Mat4) => {
    const node = nodes[i];
    if (!node) return;
    const m = multiply(parent, localMatrix(node));
    for (const p of node.mesh !== undefined ? (json.meshes?.[node.mesh]?.primitives ?? []) : []) {
      const acc = json.accessors?.[p.attributes.POSITION ?? -1];
      if (!acc?.min || !acc.max) continue;
      const lo = acc.min;
      const hi = acc.max;
      for (let c = 0; c < 8; c++) {
        const v = [0, 1, 2].map((k) => ((c >> k) & 1 ? hi[k]! : lo[k]!));
        for (let k = 0; k < 3; k++) {
          const w = m[k]! * v[0]! + m[4 + k]! * v[1]! + m[8 + k]! * v[2]! + m[12 + k]!;
          min[k] = Math.min(min[k]!, w);
          max[k] = Math.max(max[k]!, w);
        }
      }
    }
    for (const child of node.children ?? []) visit(child, m);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const children = new Set(nodes.flatMap((n) => n.children ?? []));
  const roots =
    json.scenes?.[json.scene ?? 0]?.nodes ?? nodes.map((_, i) => i).filter((i) => !children.has(i));
  for (const r of roots) visit(r, identity);
  if (min[0] === Infinity) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

/** Origine d'après la boîte : base au niveau 0 (pied), centrée en hauteur (centre), sinon décalée. */
export function modelOrigin(b: Box3Like, tolerance = 0.02): ModelOrigin {
  const h = b.max[1] - b.min[1] || 1;
  if (Math.abs(b.min[1]) <= tolerance * h) return 'pied';
  if (Math.abs((b.min[1] + b.max[1]) / 2) <= tolerance * h) return 'centre';
  return 'décalée';
}

/** Budget d'un décor (bâtiment, véhicule, prop, végétation) : triangles, textures, poids. */
export interface PropBudget {
  maxTriangles: number;
  maxTextures: number;
  maxTextureSize: number;
  maxFileMB: number;
}

/** Dépassements du budget d'un décor (liste vide = conforme). Texture au plus `maxTextureSize`. */
export function propOverBudget(r: ModelReport, bytes: number, budget: PropBudget): string[] {
  const issues: string[] = [];
  if (r.triangles > budget.maxTriangles) issues.push(`${r.triangles} triangles`);
  if (r.textures > budget.maxTextures) issues.push(`${r.textures} textures`);
  if (r.maxTexture > budget.maxTextureSize) issues.push(`texture ${r.maxTexture}px`);
  if (bytes > budget.maxFileMB * 1024 * 1024) issues.push(`${(bytes / 1048576).toFixed(2)} Mo`);
  return issues;
}

/** Dépassements du budget iPad (liste vide = dans le budget). */
export function overBudget(r: ModelReport, bytes: number, budget: ModelBudget): string[] {
  const issues: string[] = [];
  if (r.triangles > budget.maxTriangles) issues.push(`${r.triangles} triangles`);
  if (r.drawCalls > budget.maxDrawCalls) issues.push(`${r.drawCalls} draw calls`);
  if (r.maxTexture >= budget.maxTextureSize) issues.push(`texture ${r.maxTexture}px`);
  if (bytes > budget.maxFileMB * 1024 * 1024) issues.push(`${(bytes / 1048576).toFixed(1)} Mo`);
  return issues;
}
