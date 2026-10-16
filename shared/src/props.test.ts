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
import { gameData, parseGameData, type RawGameData } from './data';
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
