/**
 * Budget iPad des modèles 3D (`npm run models [fichiers ou dossiers...]`) : poids, triangles,
 * draw calls après fusion, plus grande texture, animations. Sans argument : les modèles de
 * characters.json. Code de sortie 1 si un fichier sort du budget de config.characters.budget.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { gameData, inspectGltf, overBudget, type GltfJson } from '../shared/src/index';

const ROOT = resolve(import.meta.dirname, '..');

/** JSON + octets des images d'un .gltf (data URI ou fichier voisin) ou d'un .glb. */
export function readModel(file: string) {
  const buf = readFileSync(file);
  let json: GltfJson & { bufferViews?: { byteOffset?: number; byteLength: number }[] };
  let bin: Buffer | null = null;
  if (extname(file).toLowerCase() === '.glb') {
    const jsonLen = buf.readUInt32LE(12);
    json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
    bin = buf.subarray(20 + jsonLen + 8);
  } else json = JSON.parse(buf.toString('utf8'));
  const imageBytes = (i: number): Uint8Array | null => {
    const image = json.images?.[i];
    if (!image) return null;
    if (image.uri?.startsWith('data:')) return Buffer.from(image.uri.split(',')[1] ?? '', 'base64');
    if (image.uri) return readFileSync(join(dirname(file), decodeURIComponent(image.uri)));
    const view = image.bufferView !== undefined ? json.bufferViews?.[image.bufferView] : undefined;
    const start = view?.byteOffset ?? 0;
    return view && bin ? bin.subarray(start, start + view.byteLength) : null;
  };
  return { report: inspectGltf(json, imageBytes), bytes: statSync(file).size };
}

function collect(path: string): string[] {
  if (statSync(path).isDirectory()) return readdirSync(path).flatMap((f) => collect(join(path, f)));
  return /\.(gltf|glb)$/i.test(path) ? [path] : [];
}

const args = process.argv.slice(2);
const files = args.length
  ? args.flatMap((a) => collect(resolve(a)))
  : [...gameData.characters.values()].map((c) => join(ROOT, 'client/public', c.model));
let bad = 0;
for (const f of files) {
  const { report: r, bytes } = readModel(f);
  const issues = overBudget(r, bytes, gameData.config.characters.budget);
  if (issues.length) bad++;
  console.log(
    `${issues.length ? '✗' : '✓'} ${relative(ROOT, f)} : ${(bytes / 1048576).toFixed(2)} Mo, ` +
      `${r.triangles} tri, ${r.primitives} primitives → ${r.drawCalls} draw call(s) après fusion, ` +
      `texture ${r.maxTexture || 'aucune'}, anims ${r.animations.length}` +
      (issues.length ? ` → ${issues.join(', ')}` : ''),
  );
}
process.exit(bad ? 1 : 0);
