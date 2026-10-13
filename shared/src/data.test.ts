import { describe, expect, it } from 'vitest';
import configJson from '../data/config.json';
import economyJson from '../data/economy.json';
import itemsJson from '../data/items.json';
import locationsJson from '../data/locations.json';
import { gameData, parseGameData, type RawGameData } from './data';

const raw = (): RawGameData =>
  structuredClone({
    config: configJson,
    economy: economyJson,
    items: itemsJson,
    locations: locationsJson,
  });

describe('données du jeu', () => {
  it('charge et indexe les 4 fichiers JSON', () => {
    expect(gameData.items.get('pouch_base')?.contraband).toBe(true);
    expect(gameData.items.get('cash_clean')?.storage).toBe('account');
    expect(gameData.economy.inventory).toEqual({ bagSlots: 10, stockSlots: 60 });
    expect(gameData.economy.dealer.weeklyCost).toBe(100);
  });

  it('ne contient que la zone 1 avec ses 6 lieux', () => {
    expect([...gameData.zones.keys()]).toEqual(['zone1']);
    expect([...gameData.locations.keys()].sort()).toEqual(
      ['epicerie', 'local', 'point_relais', 'repaire_jefe', 'ruelles', 'shop'].sort(),
    );
    for (const loc of gameData.locations.values()) expect(loc.zone).toBe('zone1');
  });

  it('place chaque lieu dans les bornes de sa zone', () => {
    for (const loc of gameData.locations.values()) {
      const b = gameData.zones.get(loc.zone)!.bounds;
      expect(loc.position.x).toBeGreaterThanOrEqual(b.minX);
      expect(loc.position.x).toBeLessThanOrEqual(b.maxX);
      expect(loc.position.z).toBeGreaterThanOrEqual(b.minZ);
      expect(loc.position.z).toBeLessThanOrEqual(b.maxZ);
    }
  });

  it('reflète une valeur modifiée dans le JSON sans toucher au code', () => {
    const r = raw();
    (r.economy as { strains: { pouchSellPrice: number }[] }).strains[0]!.pouchSellPrice = 999;
    expect(parseGameData(r).economy.strains[0]!.pouchSellPrice).toBe(999);
  });

  it('refuse un JSON invalide avec un message lisible', () => {
    const r = raw();
    (r.economy as { inventory: { bagSlots: unknown } }).inventory.bagSlots = 'dix';
    expect(() => parseGameData(r)).toThrow(/economy\.json invalide[\s\S]*inventory\.bagSlots/);
  });

  it('refuse une référence croisée cassée', () => {
    const r = raw();
    const locs = r.locations as { locations: { catalog: { id: string }[] }[] };
    locs.locations[1]!.catalog[0]!.id = 'caviar';
    expect(() => parseGameData(r)).toThrow(/item inconnu "caviar"/);
  });
});
