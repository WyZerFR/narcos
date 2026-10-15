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
import { resolveCharacterId } from './characters';
import { gameData, parseGameData, type RawGameData } from './data';
import { inspectGltf, overBudget, type GltfJson } from './modelBudget';
import { CharactersFileSchema } from './schemas';

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
  });
type File = { characters: { id: string; model: string; height: number }[] };

describe('characters.json', () => {
  it('ids et fichiers uniques, plafond respecté, chaque catégorie fournie, perso_1 par défaut', () => {
    const list = charactersJson.characters;
    const rules = gameData.config.characters;
    expect(new Set(list.map((c) => c.id)).size).toBe(list.length);
    expect(new Set(list.map((c) => c.model)).size).toBe(list.length);
    expect(list.length).toBeLessThanOrEqual(rules.maxCount);
    for (const cat of rules.categories)
      expect(
        list.some((c) => c.category === cat.id),
        cat.id,
      ).toBe(true);
    expect(rules.defaultId).toBe('perso_1');
    expect(rules.budget.maxDrawCalls).toBe(1);
  });

  it('catégorie inconnue ou trop de personnages : refusé au chargement', () => {
    const bad = raw();
    (bad.characters as { characters: { category: string }[] }).characters[0]!.category = 'robot';
    expect(() => parseGameData(bad)).toThrow(/perso_1, catégorie "robot" inconnue/);
    const many = raw();
    (many.config as { characters: { maxCount: number } }).characters.maxCount = 1;
    expect(() => parseGameData(many)).toThrow(/personnages, max 1/);
  });

  it('validation zod : chemin, hauteur et id', () => {
    const ok = structuredClone(charactersJson);
    expect(CharactersFileSchema.safeParse(ok).success).toBe(true);
    for (const patch of [
      { model: '../secret.gltf' },
      { model: 'models/perso.fbx' },
      { height: 0 },
      { id: 'Perso 1' },
    ]) {
      const bad = structuredClone(charactersJson);
      Object.assign(bad.characters[0]!, patch);
      expect(CharactersFileSchema.safeParse(bad).success, JSON.stringify(patch)).toBe(false);
    }
    expect(CharactersFileSchema.safeParse({ characters: [] }).success).toBe(false);
  });

  it('cohérence au chargement : id unique et défaut connu', () => {
    const dup = raw();
    const file = dup.characters as File;
    file.characters.push({ ...file.characters[0]! });
    expect(() => parseGameData(dup)).toThrow(/characters\.json : id en double "perso_1"/);
    const unknown = raw();
    (unknown.config as { characters: { defaultId: string } }).characters.defaultId = 'perso_9';
    expect(() => parseGameData(unknown)).toThrow(/defaultId "perso_9" inconnu/);
  });

  it('id inconnu ou absent remplacé par le défaut', () => {
    expect(resolveCharacterId(gameData, 'perso_2')).toBe('perso_2');
    expect(resolveCharacterId(gameData, 'perso_42')).toBe('perso_1');
    expect(resolveCharacterId(gameData, undefined)).toBe('perso_1');
    expect(resolveCharacterId(gameData, 3)).toBe('perso_1');
  });

  for (const c of gameData.characters.values())
    it(`${c.id} : fichier présent, dans le budget iPad, animations trouvées`, () => {
      const file = join(PUBLIC, c.model);
      expect(existsSync(file), file).toBe(true);
      const json = JSON.parse(readFileSync(file, 'utf8')) as GltfJson;
      const report = inspectGltf(json);
      expect(overBudget(report, statSync(file).size, gameData.config.characters.budget)).toEqual(
        [],
      );
      for (const name of Object.values(c.animations)) expect(report.animations).toContain(name);
    });
});

describe('budget des modèles', () => {
  const tri = (count: number) => ({ count });
  it('compte triangles et draw calls après fusion des parties skinnées', () => {
    const json: GltfJson = {
      accessors: [tri(30), tri(60), tri(9)],
      meshes: [
        {
          primitives: [
            { indices: 0, attributes: {} },
            { indices: 1, attributes: {} },
          ],
        },
        { primitives: [{ attributes: { POSITION: 2 } }] },
      ],
      nodes: [{ mesh: 0, skin: 0 }, { mesh: 0, skin: 0 }, { mesh: 1 }],
    };
    const r = inspectGltf(json);
    expect(r.triangles).toBe(33);
    expect(r.primitives).toBe(3);
    expect(r.drawCalls).toBe(2); // une skin + un maillage statique
  });

  it('signale texture 2048, poids et triangles au-delà', () => {
    const budget = gameData.config.characters.budget;
    const png = new Uint8Array(24);
    const view = new DataView(png.buffer);
    view.setUint32(0, 0x89504e47);
    view.setUint32(16, 2048);
    view.setUint32(20, 1024);
    const r = inspectGltf({ images: [{ uri: 'x.png' }] }, () => png);
    expect(r.maxTexture).toBe(2048);
    expect(overBudget(r, 6 * 1048576, budget)).toEqual(['texture 2048px', '6.0 Mo']);
    expect(overBudget({ ...r, maxTexture: 0, triangles: 20000 }, 1, budget)).toEqual([
      '20000 triangles',
    ]);
  });
});
