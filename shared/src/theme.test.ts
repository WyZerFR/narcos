import { describe, expect, it } from 'vitest';
import { gameData } from './data';
import { ConfigSchema, THEME_IDS } from './schemas';
import {
  checkTheme,
  dynamicLightCount,
  emissiveUses,
  realShadowsEnabled,
  resolveThemeId,
  themedPalette,
} from './theme';

const { config } = gameData;
const quartiers = [...gameData.quartiers.values()];
const locations = [...gameData.locations.values()];

describe('thème visuel', () => {
  it('le thème néo-cartel est celui par défaut et lit ses couleurs dans la config', () => {
    expect(config.theme.default).toBe('cartel');
    const t = config.theme.cartel;
    expect(t.palette).toMatchObject({ sky: '#12131a', street: '#1e1e24', ground: '#2b2d42' });
    expect(t.ambient).toMatchObject({ color: '#7c7fff', intensity: 0.6 });
    expect(t.sun).toMatchObject({ color: '#fff5ea', intensity: 1.2 });
    expect(config.theme.legacy_night.hemisphere).not.toBeNull();
    expect(ConfigSchema.safeParse(config).success).toBe(true);
  });

  it('palette thémée : asphalte, trottoirs et ciel remplacés, le reste conservé', () => {
    const p = themedPalette(config, 'cartel');
    expect(p.street).toBe('#1e1e24');
    expect(p.ground).toBe('#2b2d42');
    expect(p.wall).toBe(config.palette.wall);
    expect(themedPalette(config, 'legacy_night')).toEqual(config.palette);
  });

  it('thème inconnu ou absent : celui par défaut', () => {
    expect(resolveThemeId(config, 'legacy_night')).toBe('legacy_night');
    expect(resolveThemeId(config, 'rose_bonbon')).toBe('cartel');
    expect(resolveThemeId(config, undefined)).toBe('cartel');
  });

  it('budget : au plus 2 lumières dynamiques (soleil + lumière du joueur)', () => {
    expect(config.render.maxDynamicLights).toBe(2);
    for (const id of THEME_IDS)
      expect(dynamicLightCount(config.theme[id])).toBeLessThanOrEqual(
        config.render.maxDynamicLights,
      );
    const tight = { ...config, render: { ...config.render, maxDynamicLights: 1 } };
    expect(checkTheme(tight, locations, gameData.blocks, quartiers).join()).toMatch(
      /theme\.cartel dépasse/,
    );
  });

  it('aucune ombre temps réel en qualité basse et moyenne, ni sur tactile', () => {
    expect(realShadowsEnabled(config, 'low', false)).toBe(false);
    expect(realShadowsEnabled(config, 'medium', false)).toBe(false);
    expect(realShadowsEnabled(config, 'high', false)).toBe(true);
    expect(realShadowsEnabled(config, 'high', true)).toBe(false);
    expect(config.render.realShadows.mapSize).toBe(1024);
  });

  it('tous les émissifs des données sont listés dans config.neons', () => {
    const allowed = new Set(Object.values(config.neons));
    const uses = emissiveUses(config, locations, gameData.blocks, quartiers);
    expect(uses.length).toBeGreaterThan(10);
    for (const u of uses) expect(allowed.has(u.color), u.where).toBe(true);
    const rogue = [{ ...locations[0]!, neonColor: '#123456' }];
    expect(checkTheme(config, rogue, [], [])).toEqual([
      `locations.json ${locations[0]!.id} : émissif #123456 absent de config.neons`,
    ]);
  });

  it('néons des lieux clés : Local turquoise, banque or, repaire magenta', () => {
    expect(gameData.locations.get('local')!.neonColor).toBe(config.neons.turquoise);
    expect(gameData.locations.get('banque')!.neonColor).toBe(config.neons.gold);
    expect(gameData.locations.get('repaire_jefe')!.neonColor).toBe(config.neons.magenta);
  });
});

describe('thème neutre', () => {
  const { theme } = gameData.config;

  it('éclairage doux : sans bloom, halos coupés, brouillard plus léger, thèmes existants gardés', () => {
    expect(THEME_IDS).toEqual(['cartel', 'legacy_night', 'neutral']);
    expect(theme.neutral.bloom).toBe(false);
    expect(theme.neutral.halos).toBe(false);
    expect(theme.neutral.playerLight).toBeNull();
    expect(theme.neutral.fog.near).toBeGreaterThan(theme.cartel.fog.near);
    expect(theme.neutral.fog.far).toBeGreaterThan(theme.cartel.fog.far);
    // les thèmes existants gardent bloom et halos (défaut du schéma)
    expect(theme.cartel.bloom && theme.cartel.halos).toBe(true);
    expect(theme.legacy_night.bloom && theme.legacy_night.halos).toBe(true);
  });
});
