import type {
  Area,
  Block,
  GameConfig,
  GameLocation,
  Palette,
  Quality,
  QuartierParams,
  Theme,
  ThemeId,
} from './schemas';
import { THEME_IDS } from './schemas';

/** Thème demandé s'il existe, sinon celui par défaut (`config.theme.default`). */
export function resolveThemeId(config: GameConfig, id: unknown): ThemeId {
  return THEME_IDS.find((t) => t === id) ?? config.theme.default;
}

export function themeOf(config: GameConfig, id: ThemeId): Theme {
  return config.theme[id];
}

/** Palette de base où le thème remplace ses couleurs (ciel, asphalte, trottoirs…). */
export function themedPalette(config: GameConfig, id: ThemeId): Palette {
  return { ...config.palette, ...themeOf(config, id).palette };
}

/** Lumières qui coûtent une passe d'éclairage par sommet : soleil + lumière du joueur. */
export function dynamicLightCount(theme: Theme): number {
  return 1 + (theme.playerLight ? 1 : 0);
}

/** Ombre portée temps réel : seulement aux qualités autorisées, jamais sur écran tactile s'il l'interdit. */
export function realShadowsEnabled(config: GameConfig, quality: Quality, touch: boolean): boolean {
  const rs = config.render.realShadows;
  return rs.qualities.includes(quality) && (rs.touch || !touch);
}

/** Une couleur émissive utilisée par les données, avec sa provenance (messages d'erreur). */
export interface EmissiveUse {
  where: string;
  color: string;
}

/**
 * Toutes les couleurs émissives des données (néons des lieux et blocs, enseignes des tours,
 * gyrophares, néons et ampoules des quartiers) : chacune doit figurer dans `config.neons`.
 */
export function emissiveUses(
  config: GameConfig,
  locations: readonly GameLocation[],
  blocks: readonly Block[],
  quartiers: Iterable<QuartierParams>,
  areas: Iterable<Area> = [],
): EmissiveUse[] {
  const out: EmissiveUse[] = [];
  for (const l of locations) out.push({ where: `locations.json ${l.id}`, color: l.neonColor });
  for (const b of blocks)
    if (b.neonColor) out.push({ where: `locations.json bloc ${b.id}`, color: b.neonColor });
  for (const c of config.city.towers.neonColors)
    out.push({ where: 'config.json city.towers.neonColors', color: c });
  for (const c of config.render.halo.beaconColors)
    out.push({ where: 'config.json render.halo.beaconColors', color: c });
  for (const q of quartiers) {
    out.push({ where: `quartiers.json ${q.id} palette.neon`, color: q.palette.neon });
    out.push({ where: `quartiers.json ${q.id} palette.lamp`, color: q.palette.lamp });
  }
  for (const a of areas) {
    if (a.palette.neon)
      out.push({ where: `areas.json ${a.id} palette.neon`, color: a.palette.neon });
    for (const [t, p] of Object.entries(a.themePalettes))
      if (p?.neon) out.push({ where: `areas.json ${a.id} themePalettes.${t}.neon`, color: p.neon });
  }
  return out;
}

/** Incohérences du thème et des néons (appelé par `parseGameData`). */
export function checkTheme(
  config: GameConfig,
  locations: readonly GameLocation[],
  blocks: readonly Block[],
  quartiers: Iterable<QuartierParams>,
  areas: Iterable<Area> = [],
): string[] {
  const errors: string[] = [];
  for (const id of THEME_IDS) {
    const t = config.theme[id];
    if (dynamicLightCount(t) > config.render.maxDynamicLights)
      errors.push(`config.json : theme.${id} dépasse render.maxDynamicLights`);
    if (t.fog.near >= t.fog.far) errors.push(`config.json : theme.${id}.fog, near doit être < far`);
    const areaIds = new Set([...areas].map((a) => a.id));
    for (const areaId of Object.keys(t.grass?.density ?? {}))
      if (areaIds.size > 0 && !areaIds.has(areaId))
        errors.push(`config.json : theme.${id}.grass.density, area inconnue "${areaId}"`);
    if (t.outline?.qualities.includes('low'))
      errors.push(`config.json : theme.${id}.outline, jamais en qualité basse`);
    if (t.shading.steps.some((s, i) => i > 0 && s <= t.shading.steps[i - 1]!))
      errors.push(`config.json : theme.${id}.shading.steps doit être croissant`);
  }
  const allowed = new Set(Object.values(config.neons).map((c) => c.toLowerCase()));
  for (const u of emissiveUses(config, locations, blocks, quartiers, areas))
    if (!allowed.has(u.color.toLowerCase()))
      errors.push(`${u.where} : émissif ${u.color} absent de config.neons`);
  return errors;
}

// ---------------------------------------------------------------- luminance des faces (calcul)

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Luminance linéaire (Rec. 709) d'une couleur hexadécimale sRGB, × `scale`. */
export function hexLuminance(hex: string, scale = 1): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => srgbToLinear(v / 255));
  return (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) * scale;
}

/** Tone mapping « Khronos PBR Neutral » de three, sur une valeur grise. */
function neutralToneMap(x: number): number {
  const start = 0.8 - 0.04;
  const v = x - (x < 0.08 ? x - 6.25 * x * x : 0.04);
  if (v < start) return v;
  const d = 1 - start;
  return 1 - (d * d) / (v + d - start);
}

/**
 * Éclairement (luminance) reçu par une face de normale `n` (unitaire) sous le thème, comme le
 * calcule three : ambiante + hémisphère (mélange sol / ciel selon n.y) + soleil, ce dernier passé
 * par le dégradé du toon (palier lu en `dot(n, L) × 0,5 + 0,5`, au plus proche) ou en Lambert.
 */
export function faceIrradiance(theme: Theme, n: readonly [number, number, number]): number {
  const [sx, sy, sz] = theme.sun.position;
  const len = Math.hypot(sx, sy, sz);
  const dotNL = (n[0] * sx + n[1] * sy + n[2] * sz) / len;
  const steps = theme.shading.steps;
  const sunFactor =
    theme.shading.mode === 'toon'
      ? steps[
          Math.min(steps.length - 1, Math.max(0, Math.floor((dotNL * 0.5 + 0.5) * steps.length)))
        ]!
      : Math.max(0, dotNL);
  const ambient = theme.ambient
    ? hexLuminance(theme.ambient.color, theme.ambient.scale) * theme.ambient.intensity
    : 0;
  let hemi = 0;
  if (theme.hemisphere) {
    const w = 0.5 * n[1] + 0.5;
    const { sky, ground, intensity } = theme.hemisphere;
    hemi =
      (hexLuminance(ground.color, ground.scale) * (1 - w) +
        hexLuminance(sky.color, sky.scale) * w) *
      intensity;
  }
  const sun = hexLuminance(theme.sun.color, theme.sun.scale) * theme.sun.intensity * sunFactor;
  return ambient + hemi + sun;
}

/**
 * Luminance affichée d'une face (albédo linéaire `albedo`) : BRDF de Lambert (÷ π), exposition,
 * tone mapping neutre (approché pour les autres). `lit` : face au soleil (n = L), sinon face
 * opposée (n = −L), la plus sombre.
 */
export function faceLuminance(theme: Theme, albedo: number, lit: boolean): number {
  const [x, y, z] = theme.sun.position;
  const len = Math.hypot(x, y, z);
  const s = lit ? 1 : -1;
  const n: [number, number, number] = [(s * x) / len, (s * y) / len, (s * z) / len];
  const v = ((albedo * faceIrradiance(theme, n)) / Math.PI) * theme.exposure;
  return theme.toneMapping === 'neutral' ? neutralToneMap(v) : Math.min(1, v);
}
