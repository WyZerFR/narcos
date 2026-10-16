/**
 * Budget iPad des modèles 3D.
 * - `npm run models [fichiers ou dossiers...]` : personnages (sans argument : characters.json),
 *   budget de config.characters.budget.
 * - `npm run models -- --props [dossiers...]` : décors. Sans dossier : les modèles de props.json ;
 *   avec un pack brut : classement par catégorie d'après le nom, cas douteux signalés.
 *   Triangles, draw calls après fusion, textures (nombre, taille), poids, boîte englobante,
 *   origine, budget de config.props.budget[catégorie].
 * Code de sortie 1 si un fichier sort du budget.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import {
  gameData,
  inspectGltf,
  modelOrigin,
  overBudget,
  propOverBudget,
  type GltfJson,
  type PropCategory,
} from '../shared/src/index';

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
  // poids réel : le fichier et ses images externes (.gltf + textures voisines)
  const external = (json.images ?? [])
    .filter((im) => im.uri && !im.uri.startsWith('data:'))
    .reduce((n, im) => n + statSync(join(dirname(file), decodeURIComponent(im.uri!))).size, 0);
  return { report: inspectGltf(json, imageBytes), bytes: statSync(file).size + external };
}

function collect(path: string): string[] {
  if (statSync(path).isDirectory()) return readdirSync(path).flatMap((f) => collect(join(path, f)));
  return /\.(gltf|glb)$/i.test(path) ? [path] : [];
}

/** Classement d'un fichier de pack brut d'après son nom ; `doubt` = raison d'écarter ou de vérifier. */
export function classify(file: string): { category: PropCategory; doubt: string | null } {
  const name = file.replace(/\\/g, '/').toLowerCase();
  const base = name.split('/').pop()!;
  if (
    /\/glb format coaster\//.test(name) &&
    /^(coaster|support|queue|ride|station|train)/.test(base)
  )
    return {
      category: 'props',
      doubt: "pièce de montagnes russes (parc d'attractions, hors thème)",
    };
  if (/\/glb format market\//.test(name))
    return /character/.test(base)
      ? { category: 'props', doubt: 'personnage, pas un décor' }
      : { category: 'props', doubt: "kit d'intérieur de supérette (murs, rayons)" };
  if (/^(debris|wheel)/.test(base))
    return { category: 'props', doubt: 'pièce détachée de véhicule' };
  if (/^(kart|race|tractor)/.test(base))
    return { category: 'vehicules', doubt: 'véhicule hors ville (course, ferme)' };
  if (/^cliff|^ground_|^bridge|^path_|^crops?_|^platform/.test(base))
    return { category: 'props', doubt: 'pièce de terrain en tuile' };
  if (/^(bed|tent|campfire|canoe|statue|mushroom|lily|hanging|pot_|crop)/.test(base))
    return { category: 'props', doubt: 'décor nature hors thème urbain' };
  if (/ambulance|delivery|firetruck|garbage|hatchback|police|sedan|suv|taxi|truck|van/.test(base))
    return { category: 'vehicules', doubt: null };
  if (/building|skyscraper|water-tower|chimney|windmill|stall|park-entrance/.test(base))
    return { category: 'batiments', doubt: null };
  if (/tree|plant|bush|flower|grass|cactus|stump|log|planter/.test(base))
    return { category: 'vegetation', doubt: null };
  return { category: 'props', doubt: null };
}

const args = process.argv.slice(2);
const propsMode = args.includes('--props');
const paths = args.filter((a) => a !== '--props');
let bad = 0;

if (!propsMode) {
  const files = paths.length
    ? paths.flatMap((a) => collect(resolve(a)))
    : [...gameData.characters.values()].map((c) => join(ROOT, 'client/public', c.model));
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
} else {
  const cfg = gameData.config.props;
  const entries = paths.length
    ? paths.flatMap((a) => collect(resolve(a))).map((f) => ({ file: f, ...classify(f) }))
    : [...gameData.props.values()].map((p) => ({
        file: join(ROOT, 'client/public', p.model),
        category: p.category,
        doubt: null,
      }));
  let total = 0;
  for (const { file, category, doubt } of entries) {
    const { report: r, bytes } = readModel(file);
    total += bytes;
    const issues = propOverBudget(r, bytes, cfg.budget[category]);
    if (issues.length && !doubt) bad++;
    const b = r.bounds;
    const size = [0, 1, 2].map((k) => (b.max[k]! - b.min[k]!).toFixed(2)).join(' × ');
    const mark = doubt ? '?' : issues.length ? '✗' : '✓';
    console.log(
      `${mark} [${category}] ${relative(ROOT, file)} : ${(bytes / 1024).toFixed(0)} Ko, ` +
        `${r.triangles} tri, ${r.drawCalls} draw call(s) après fusion, ` +
        `${r.textures} texture(s) ${r.maxTexture ? `${r.maxTexture}px` : ''}, boîte ${size}, ` +
        `origine ${modelOrigin(b, cfg.originTolerance)}` +
        (issues.length ? ` → ${issues.join(', ')}` : '') +
        (doubt ? ` → douteux : ${doubt}` : ''),
    );
  }
  const over = total > cfg.maxTotalMB * 1048576;
  if (over && !paths.length) bad++;
  console.log(
    `${entries.length} fichier(s), ${(total / 1048576).toFixed(2)} Mo au total` +
      (over ? ` (au-delà de ${cfg.maxTotalMB} Mo)` : ''),
  );
}
process.exit(bad ? 1 : 0);
