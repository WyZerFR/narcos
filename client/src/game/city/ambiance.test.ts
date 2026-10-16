import { describe, expect, it } from 'vitest';
import { areaAt, gameData, rectContainsPoint, type Rect } from '@narco/shared';
import { gardenGlowColor, gardenLights } from './buildQuartiers';
import { haloPlacements } from './haloPlacements';
import { themedData } from './themedData';

const AREAS = [...gameData.areas.values()];
const areaOf = (p: { x: number; z: number }) => areaAt(AREAS, p)?.id;

describe('ambiance par zone', () => {
  it('chaque area a sa palette ; l’ancien thème les ignore', () => {
    expect(gameData.areas.get('bas_fonds')!.palette.wall).toBeDefined();
    expect(gameData.areas.get('centre_ville')!.palette.wall).toBeDefined();
    expect(gameData.areas.get('cartel')!.palette.neon).toBe(gameData.config.neons.magenta);
    const legacy = themedData(gameData, 'legacy_night');
    for (const a of legacy.areas.values()) expect(a.palette).toEqual({});
    expect(themedData(gameData, 'cartel').areas).toBe(gameData.areas);
  });

  it('cartel : palette jaune archivée sous cartel_yellow, non utilisée', () => {
    const nord = [...gameData.quartiers.values()].find((q) => q.areaId === 'cartel')!;
    const yellow = nord.archivedPalettes.cartel_yellow!;
    expect(yellow.neon).toBe('#fff44f');
    expect(nord.palette.neon).not.toBe(yellow.neon);
    expect(nord.palette.facades.some((c) => yellow.facades.includes(c))).toBe(false);
  });

  it('commerces regroupés dans le quartier commercial, police et banque au centre', () => {
    const style = (s: string) =>
      gameData.blocks.filter((b) => b.style === s).map((b) => areaOf(b.position));
    for (const s of ['dealership', 'gunshop', 'laundry', 'barber', 'kebab'])
      expect(style(s), s).toEqual(['commercial']);
    expect(areaOf(gameData.locations.get('shop')!.position)).toBe('commercial');
    expect(style('police')).toEqual(['centre_ville']);
    expect(areaOf(gameData.locations.get('banque')!.position)).toBe('centre_ville');
    expect(style('containers')).toEqual(['cartel']);
    expect(style('factory')).toEqual(['cartel']);
    expect(gameData.config.decor.cars.filter((c) => c.police).length).toBeGreaterThan(0);
  });

  it('aucun lieu décoratif interactif : les blocs ne sont ni lieux ni intérieurs', () => {
    for (const b of gameData.blocks) {
      expect(gameData.locations.has(b.id), b.id).toBe(false);
      expect(gameData.interiors.has(b.id), b.id).toBe(false);
    }
  });
});

describe('jardins cachés indiscernables', () => {
  const layouts = [...gameData.quartierLayouts.values()].filter((l) => l.gardens.length > 0);

  it('les 3 jardins ont exactement les mêmes lueur et ampoule', () => {
    const all = layouts.flatMap((l) => l.gardens.map(() => l));
    expect(all).toHaveLength(3);
    for (const l of layouts) {
      const q = gameData.quartiers.get(l.id)!;
      const lights = l.gardens.map(() => gardenLights(gardenGlowColor(q, gameData)));
      for (const other of lights) expect(other).toEqual(lights[0]);
      // pas de couleur propre au vrai jardin : même teinte avec ou sans trappe
      expect(new Set(lights.flat().map((x) => x.color)).size).toBe(1);
    }
  });

  it('aucun halo, aucune icône dans un jardin ou sur la trappe', () => {
    const halos = haloPlacements(gameData);
    const zones: Rect[] = layouts.flatMap((l) => l.gardens.flatMap((g) => [g.garden, g.passage]));
    for (const z of zones) for (const h of halos) expect(rectContainsPoint(z, h)).toBe(false);
    for (const loc of gameData.locations.values()) if (loc.hidden) expect(loc.icon).toBeUndefined();
  });
});
