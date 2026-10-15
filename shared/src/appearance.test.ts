import { readFileSync } from 'node:fs';
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
import {
  appearanceKey,
  randomAppearance,
  resolveAppearance,
  slotColors,
  slotsOf,
} from './appearance';
import { gameData, parseGameData, type RawGameData } from './data';

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
type Chars = { characters: { slots: Record<string, string[]> }[] };

describe('palettes.json', () => {
  it('une dizaine de teintes par slot, couleurs hexadécimales', () => {
    for (const slot of gameData.appearanceSlots.values()) {
      expect(slot.swatches.length, slot.id).toBeGreaterThanOrEqual(8);
      expect(slot.swatches.length, slot.id).toBeLessThanOrEqual(12);
    }
    expect([...gameData.appearanceSlots.keys()]).toEqual([
      'skin',
      'hair',
      'top',
      'bottom',
      'shoes',
      'accessory',
    ]);
  });

  it('cohérence : slot inconnu ou matériau dans deux slots refusés', () => {
    const unknown = raw();
    (unknown.characters as Chars).characters[0]!.slots.cape = ['Skin'];
    expect(() => parseGameData(unknown)).toThrow(/perso_1, slot "cape" absent/);
    const twice = raw();
    (twice.characters as Chars).characters[0]!.slots.top = ['Hair'];
    expect(() => parseGameData(twice)).toThrow(/perso_1, matériau "Hair" dans deux slots/);
  });

  for (const c of gameData.characters.values())
    it(`${c.id} : les matériaux des slots existent dans le modèle`, () => {
      const file = join(import.meta.dirname, '../../client/public', c.model);
      const json = JSON.parse(readFileSync(file, 'utf8')) as { materials?: { name?: string }[] };
      const names = new Set((json.materials ?? []).map((m) => m.name));
      expect(Object.keys(c.slots).length).toBeGreaterThan(0);
      for (const list of Object.values(c.slots)) for (const m of list) expect(names).toContain(m);
    });
});

describe('apparence', () => {
  it('teinte inconnue, slot absent du modèle ou valeur invalide : retirés (couleur d’origine)', () => {
    expect(
      resolveAppearance(gameData, 'perso_2', {
        skin: 'peau_3',
        hair: 'arc_en_ciel',
        top: 'tissu_5',
        accessory: 'tissu_1', // perso_2 n'a pas d'accessoire
        bottom: 42,
      }),
    ).toEqual({ skin: 'peau_3', top: 'tissu_5' });
    expect(resolveAppearance(gameData, 'perso_2', 'rouge')).toEqual({});
    expect(resolveAppearance(gameData, 'perso_2', null)).toEqual({});
    expect(resolveAppearance(gameData, 'inconnu', { skin: 'peau_1' })).toEqual({});
    // une teinte de cheveux n'est pas valable pour la peau
    expect(resolveAppearance(gameData, 'perso_2', { skin: 'cheveux_1' })).toEqual({});
  });

  it('aléatoire : une teinte valide par slot du modèle', () => {
    let n = 0;
    const rand = () => ((n += 0.37) % 1) * 0.999;
    for (const c of gameData.characters.values()) {
      const a = randomAppearance(gameData, c.id, rand);
      expect(Object.keys(a)).toEqual(slotsOf(gameData, c.id).map((s) => s.id));
      expect(resolveAppearance(gameData, c.id, a)).toEqual(a);
    }
  });

  it('couleurs par rang de slot pour le shader (0 = origine)', () => {
    const colors = slotColors(gameData, { hair: 'cheveux_1' });
    expect(colors).toHaveLength(gameData.appearanceSlots.size + 1);
    expect(colors[0]).toBeNull();
    expect(colors[gameData.appearanceSlots.get('hair')!.index]).toBe('#141110');
    expect(colors[gameData.appearanceSlots.get('skin')!.index]).toBeNull();
    expect(appearanceKey({ top: 'a', hair: 'b' })).toBe(appearanceKey({ hair: 'b', top: 'a' }));
  });
});
