import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import configJson from '../data/config.json';
import economyJson from '../data/economy.json';
import itemsJson from '../data/items.json';
import locationsJson from '../data/locations.json';
import zonesJson from '../data/zones.json';
import shopsJson from '../data/shops.json';
import npcsJson from '../data/npcs.json';
import dialoguesJson from '../data/dialogues.json';
import areasJson from '../data/areas.json';
import quartiersJson from '../data/quartiers.json';
import charactersJson from '../data/characters.json';
import palettesJson from '../data/palettes.json';
import propsJson from '../data/props.json';
import placementsJson from '../data/placements.json';
import { gameData, parseGameData, type RawGameData } from './data';
import { facadePlacements, hasFacade } from './props';
import {
  inspectGltf,
  modelOrigin,
  propOverBudget,
  sceneBounds,
  type GltfJson,
} from './modelBudget';

const PUBLIC = join(import.meta.dirname, '../../client/public');
const raw = (): RawGameData =>
  structuredClone({
    config: configJson,
    economy: economyJson,
    items: itemsJson,
    locations: locationsJson,
    zones: zonesJson,
    shops: shopsJson,
    npcs: npcsJson,
    dialogues: dialoguesJson,
    areas: areasJson,
    quartiers: quartiersJson,
    characters: charactersJson,
    palettes: palettesJson,
    props: propsJson,
  });

function glbJson(file: string): GltfJson {
  const buf = readFileSync(file);
  return JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8')) as GltfJson;
}

describe('décor 3D importé (props.json)', () => {
  const props = [...gameData.props.values()];
  const { budget, maxTotalMB } = gameData.config.props;

  it('chaque modèle existe, dans le budget de sa catégorie, 1 draw call, sans texture', () => {
    expect(props.length).toBeGreaterThan(0);
    let total = 0;
    for (const p of props) {
      const file = join(PUBLIC, p.model);
      expect(existsSync(file), p.model).toBe(true);
      const bytes = statSync(file).size;
      total += bytes;
      const r = inspectGltf(glbJson(file));
      expect(propOverBudget(r, bytes, budget[p.category]), p.id).toEqual([]);
      expect(r.drawCalls, p.id).toBe(1);
      expect(r.textures, p.id).toBe(0);
      expect(r.triangles, p.id).toBe(p.triangles);
    }
    expect(total).toBeLessThan(maxTotalMB * 1024 * 1024);
  });

  it("boîte et décalage d'origine cohérents avec le fichier", () => {
    for (const p of props) {
      const b = sceneBounds(glbJson(join(PUBLIC, p.model)));
      for (let k = 0; k < 3; k++) {
        expect(b.min[k], p.id).toBeCloseTo(p.bounds.min[k]!, 2);
        expect(b.max[k], p.id).toBeCloseTo(p.bounds.max[k]!, 2);
      }
      // le décalage ramène le pied centré à l'origine
      const moved = {
        min: b.min.map((v, k) => v + p.offset[k]!) as [number, number, number],
        max: b.max.map((v, k) => v + p.offset[k]!) as [number, number, number],
      };
      expect(modelOrigin(moved), p.id).toBe('pied');
      expect(moved.min[0] + moved.max[0], p.id).toBeCloseTo(0, 2);
      expect(moved.min[2] + moved.max[2], p.id).toBeCloseTo(0, 2);
    }
  });

  it('collision dérivée de la boîte au sol, jamais plus large que le modèle', () => {
    for (const p of props) {
      if (!p.collision) continue;
      const scale = p.height / (p.bounds.max[1] - p.bounds.min[1]);
      const w = (p.bounds.max[0] - p.bounds.min[0]) * scale;
      const d = (p.bounds.max[2] - p.bounds.min[2]) * scale;
      if (p.collision.shape === 'circle')
        expect(p.collision.r, p.id).toBeLessThanOrEqual(Math.max(w, d) / 2);
      else
        expect(Math.abs(p.collision.w * p.collision.d - w * d) / (w * d), p.id).toBeLessThan(0.01);
    }
  });

  it('ids uniques, teinte obligatoire sans keepColors, dossier de la catégorie', () => {
    const dup = raw();
    const list = (dup.props as typeof propsJson).props;
    list.push(structuredClone(list[0]!));
    expect(() => parseGameData(dup)).toThrow(/props\.json : id en double/);
    const untinted = raw();
    const first = (untinted.props as typeof propsJson).props[0]! as { keepColors: boolean };
    first.keepColors = false;
    expect(() => parseGameData(untinted)).toThrow(/sans keepColors doit avoir une teinte/);
    const moved = raw();
    (moved.props as typeof propsJson).props[0]!.model = 'models/props/ailleurs.glb';
    expect(() => parseGameData(moved)).toThrow(/doit être dans models\//);
  });
});

describe('façades de lieux importées (famille facade)', () => {
  const withFacades = (facades: Record<string, string>): RawGameData => ({
    ...raw(),
    placements: { ...structuredClone(placementsJson), facades },
  });

  it("l'épicerie : modèle dans models/shops, néons, tenu dans la taille du lieu, tourné vers la porte", () => {
    expect(gameData.placements.facades.epicerie).toBe('epicerie_batiment');
    const p = gameData.props.get('epicerie_batiment')!;
    const loc = gameData.locations.get('epicerie')!;
    expect(p.family).toBe('facade');
    expect(p.model).toBe('models/shops/epicerie_batiment.glb');
    expect(p.cuttable).toBe(true);
    expect(p.emissive).toBe(true);
    expect(p.triangles).toBeLessThan(gameData.config.props.budget.batiments.maxTriangles);
    if (p.collision?.shape !== 'rect') throw new Error('collision');
    expect(p.collision.w).toBeLessThanOrEqual(loc.size.w);
    expect(p.collision.d).toBeLessThanOrEqual(loc.size.d);
    expect(facadePlacements(gameData)).toEqual([
      { locationId: 'epicerie', prop: 'epicerie_batiment', ...loc.position, rotation: 0 },
    ]);
    expect(hasFacade(gameData, 'epicerie')).toBe(true);
    expect(hasFacade(gameData, 'local')).toBe(false);
  });

  it('avant du modèle tourné vers la porte du lieu', () => {
    const turned = (door: 'north' | 'east' | 'west') =>
      facadePlacements({
        placements: gameData.placements,
        locations: new Map([['epicerie', { ...gameData.locations.get('epicerie')!, door }]]),
      })[0]!.rotation;
    expect([turned('north'), turned('east'), turned('west')]).toEqual([180, 90, 270]);
  });

  it('refusée : lieu inconnu, prop hors famille facade, façade plus grande que le lieu', () => {
    expect(() => parseGameData(withFacades({ nulle_part: 'epicerie_batiment' }))).toThrow(
      /facades\.nulle_part : lieu inconnu/,
    );
    expect(() => parseGameData(withFacades({ epicerie: 'quartier_coin' }))).toThrow(
      /n'est pas un prop de famille facade/,
    );
    // emprise 10 × 8 dans un lieu de 8 × 8
    const small = withFacades({ epicerie: 'epicerie_batiment' });
    const locs = small.locations as typeof locationsJson;
    const epicerie = locs.locations.find((l) => l.id === 'epicerie')!;
    epicerie.size = { w: 8, d: 8 };
    expect(() => parseGameData(small)).toThrow(/déborde de la taille du lieu/);
  });
});

describe('bâtiments de quartier (familles corner et row)', () => {
  const family = [...gameData.props.values()].filter(
    (p) => p.family === 'corner' || p.family === 'row',
  );

  it("un d'angle et un de rangée, emprise tenue, néons, posés une fois dans chez_nous", () => {
    expect(family.map((p) => p.family).sort()).toEqual(['corner', 'row']);
    const placed = gameData.placements.areas.chez_nous ?? [];
    for (const p of family) {
      expect(p.model.startsWith('models/quartier/'), p.id).toBe(true);
      expect(p.category, p.id).toBe('batiments');
      expect(p.rotationY, p.id).toBe(0);
      expect(p.emissive, p.id).toBe(true);
      expect(p.collision?.shape, p.id).toBe('rect');
      if (p.collision?.shape !== 'rect' || !p.footprint) throw new Error(p.id);
      expect(p.collision.w).toBeLessThanOrEqual(p.footprint.w);
      expect(p.collision.d).toBeLessThanOrEqual(p.footprint.d);
      expect(
        placed.filter((q) => q.prop === p.id),
        p.id,
      ).toHaveLength(1);
      // façade et attribut des néons dans le GLB
      const glb = glbJson(join(PUBLIC, p.model)) as unknown as {
        meshes: { primitives: { attributes: Record<string, number> }[] }[];
      };
      expect(glb.meshes[0]!.primitives[0]!.attributes._EMISSIVE, p.id).toBeDefined();
    }
  });

  it('refusé sans emprise ou avec une collision qui en déborde', () => {
    const find = (d: RawGameData) =>
      (d.props as typeof propsJson).props.find((p) => p.id === 'quartier_coin') as unknown as {
        footprint?: { w: number; d: number };
      };
    const bare = raw();
    delete find(bare).footprint;
    expect(() => parseGameData(bare)).toThrow(/sans emprise/);
    const tight = raw();
    find(tight).footprint = { w: 5, d: 5 };
    expect(() => parseGameData(tight)).toThrow(/collision rectangle hors de son emprise/);
  });
});

describe('atlas de textures des packs', () => {
  const props = [...gameData.props.values()];
  const atlases = new Set(props.flatMap((p) => (p.texture ? [p.texture] : [])));

  it('textures d’origine gardées : UV dans le GLB, atlas partagé par pack ≤ 1024 px', () => {
    expect(atlases.size).toBeGreaterThan(0);
    for (const p of props) {
      const json = glbJson(join(PUBLIC, p.model)) as GltfJson & {
        meshes: { primitives: { attributes: Record<string, number> }[] }[];
      };
      const attrs = json.meshes[0]!.primitives[0]!.attributes;
      expect('TEXCOORD_0' in attrs, p.id).toBe(Boolean(p.texture));
    }
    let bytes = 0;
    for (const t of atlases) {
      const png = readFileSync(join(PUBLIC, t));
      const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
      expect(Math.max(w, h), t).toBeLessThanOrEqual(1024);
      bytes += w * h * 4 * (4 / 3); // RGBA + mipmaps
    }
    expect(bytes).toBeLessThan(30 * 1024 * 1024);
  });
});
