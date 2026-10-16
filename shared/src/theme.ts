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
  }
  const allowed = new Set(Object.values(config.neons).map((c) => c.toLowerCase()));
  for (const u of emissiveUses(config, locations, blocks, quartiers, areas))
    if (!allowed.has(u.color.toLowerCase()))
      errors.push(`${u.where} : émissif ${u.color} absent de config.neons`);
  return errors;
}
