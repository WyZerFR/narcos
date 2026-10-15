/**
 * Budget d'un modèle glTF (JSON déjà lu, pure) : triangles, draw calls après la fusion faite par
 * le client (une SkinnedMesh par skin), plus grande texture, animations.
 */

export interface GltfJson {
  meshes?: {
    primitives?: { indices?: number; mode?: number; attributes: Record<string, number> }[];
  }[];
  nodes?: { mesh?: number; skin?: number }[];
  accessors?: { count: number }[];
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
  animations: string[];
}

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
  (json.images ?? []).forEach((_, i) => {
    const bytes = imageBytes(i);
    const s = bytes ? imageSize(bytes) : null;
    if (s) maxTexture = Math.max(maxTexture, s.w, s.h);
  });
  return {
    triangles: Math.round(triangles),
    primitives,
    drawCalls,
    maxTexture,
    animations: (json.animations ?? []).map((a) => a.name ?? ''),
  };
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
