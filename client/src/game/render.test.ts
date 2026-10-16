import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { footprint, gameData, rectContainsPoint } from '@narco/shared';
import { BackSide, MeshLambertMaterial, MeshToonMaterial, NearestFilter } from 'three';
import {
  facetedClone,
  litMaterial,
  outlineMaterial,
  shadedMaterial,
  toonGradient,
} from './materials';
import { characterMaterial } from './characters/characterAssets';
import { haloPlacements } from './city/haloPlacements';
import { themedData } from './city/themedData';
import { kitBlobs } from './blobRegistry';
import { buildCity } from './city/buildCity';

const SRC = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(f) && !f.endsWith('.test.ts') ? [p] : [];
  });
}

describe('rendu low-poly à facettes', () => {
  it('la fabrique ne produit que des matériaux à facettes', () => {
    expect(litMaterial().flatShading).toBe(true);
    expect(litMaterial({ vertexColors: true }).flatShading).toBe(true);
    expect(characterMaterial().flatShading).toBe(true);
    expect((facetedClone(new MeshLambertMaterial()) as MeshLambertMaterial).flatShading).toBe(true);
  });

  it('aucun matériau éclairé créé hors de la fabrique, tous les JSX en flatShading', () => {
    for (const file of sources(SRC)) {
      const where = relative(SRC, file);
      const code = readFileSync(file, 'utf8');
      if (!where.endsWith('materials.ts'))
        expect(code, where).not.toMatch(/new Mesh(Lambert|Phong|Standard|Physical|Toon)Material\(/);
      for (const tag of code.match(/<mesh(Lambert|Phong|Standard)Material[^>]*>/g) ?? [])
        expect(tag, where).toMatch(/flatShading/);
    }
  });

  it('géométries fusionnées non indexées : une normale par face, aucune perte de fusion', () => {
    const city = buildCity(themedData(gameData, 'cartel'));
    for (const [key, g] of city) {
      expect(g.solid?.index ?? null, key).toBeNull();
      expect(g.glow?.index ?? null, key).toBeNull();
    }
    // toujours 2 géométries au plus par area (sol/murs + néons)
    expect(city.size).toBeLessThanOrEqual(gameData.areas.size + 1);
  });

  it('couleurs lues depuis la config : la ville suit la palette du thème', () => {
    const d = themedData(gameData, 'cartel');
    expect(d.config.palette.street).toBe(gameData.config.theme.cartel.palette.street);
    expect(themedData(gameData, 'legacy_night').config.palette).toEqual(gameData.config.palette);
  });
});

describe('halos de néons et ombres blob', () => {
  const halos = haloPlacements(gameData);
  const neons = new Set(Object.values(gameData.config.neons));

  it('halos sur les devantures, couleurs de config.neons, gyrophares clignotants', () => {
    expect(halos.length).toBeGreaterThan(10);
    for (const h of halos) expect(neons.has(h.color), h.color).toBe(true);
    const beacons = halos.filter((h) => h.blinkHz > 0);
    expect(beacons.map((h) => h.color)).toEqual(gameData.config.render.halo.beaconColors);
  });

  it('aucun halo sur un lieu caché (trappe)', () => {
    for (const loc of gameData.locations.values()) {
      if (!loc.hidden) continue;
      const r = footprint(loc);
      for (const h of halos) expect(rectContainsPoint(r, h)).toBe(false);
    }
  });

  it('ombres blob : rayons de la config par type de décor', () => {
    const { radius } = gameData.config.render.blob;
    expect(kitBlobs('cars', [{ x: 1, z: 2 }], radius)).toEqual([{ x: 1, z: 2, r: radius.car }]);
    expect(kitBlobs('trees', [{ x: 0, z: 0, scale: 2 }], radius)[0]!.r).toBe(radius.tree * 2);
    expect(kitBlobs('poles', [{ x: 0, z: 0 }], radius)).toEqual([]);
  });
});

describe('thème jour : toon et contour', () => {
  const day = gameData.config.theme.day;

  it('ombrage toon à paliers (dégradé généré), à facettes ; Lambert ailleurs', () => {
    const m = shadedMaterial({ vertexColors: true }, day.shading) as MeshToonMaterial;
    expect(day.shading.mode).toBe('toon');
    expect(m).toBeInstanceOf(MeshToonMaterial);
    expect((m as unknown as { flatShading: boolean }).flatShading).toBe(true);
    const g = toonGradient(day.shading.steps);
    expect(m.gradientMap).toBe(g);
    expect(g.image.width).toBe(day.shading.steps.length);
    expect(g.magFilter).toBe(NearestFilter);
    expect(shadedMaterial({}, gameData.config.theme.cartel.shading)).toBeInstanceOf(
      MeshLambertMaterial,
    );
  });

  it('contour : faces arrière, épaisseur du thème, jamais en qualité basse', () => {
    expect(day.outline).not.toBeNull();
    expect(day.outline!.qualities).not.toContain('low');
    const m = outlineMaterial(day.outline!.width, day.outline!.color);
    expect(m.side).toBe(BackSide);
    const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>' };
    m.onBeforeCompile(shader as never, undefined as never);
    expect(shader.vertexShader).toContain('normalize(normal) * uOutline');
  });

  it('jour : tone mapping qui garde la saturation, ambiante réduite, soleil bas et chaud', () => {
    expect(day.toneMapping).not.toBe('aces');
    expect(day.ambient!.intensity).toBeLessThan(1);
    expect(day.sun.intensity).toBeGreaterThan(day.ambient!.intensity * 2);
    const [x, y, z] = day.sun.position;
    // soleil bas : élévation sous 35°
    expect(Math.atan2(y, Math.hypot(x, z))).toBeLessThan((35 * Math.PI) / 180);
  });
});
