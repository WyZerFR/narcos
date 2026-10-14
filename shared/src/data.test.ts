import { describe, expect, it } from 'vitest';
import configJson from '../data/config.json';
import economyJson from '../data/economy.json';
import itemsJson from '../data/items.json';
import locationsJson from '../data/locations.json';
import zonesJson from '../data/zones.json';
import shopsJson from '../data/shops.json';
import npcsJson from '../data/npcs.json';
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
  });

describe('données du jeu', () => {
  it('charge et indexe les 4 fichiers JSON', () => {
    expect(gameData.items.get('pouch_base')?.contraband).toBe(true);
    expect(gameData.items.get('cash_clean')?.storage).toBe('account');
    expect(gameData.config.inventory).toEqual({ bagSlots: 10, stockSlots: 60 });
    expect(gameData.economy.dealer.weeklyCost).toBe(100);
  });

  it('ne contient que la zone 1 avec ses 8 lieux', () => {
    expect([...gameData.zones.keys()]).toEqual(['zone1']);
    expect([...gameData.locations.keys()].sort()).toEqual(
      [
        'epicerie',
        'local',
        'point_relais',
        'repaire_jefe',
        'ruelle_est',
        'ruelle_nord',
        'ruelle_sud',
        'shop',
      ].sort(),
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
    (r.config as { inventory: { bagSlots: unknown } }).inventory.bagSlots = 'dix';
    expect(() => parseGameData(r)).toThrow(/config\.json invalide[\s\S]*inventory\.bagSlots/);
  });

  it('refuse une référence croisée cassée', () => {
    const r = raw();
    const locs = r.locations as { locations: { id: string; catalog: { id: string }[] }[] };
    locs.locations.find((l) => l.id === 'repaire_jefe')!.catalog[0]!.id = 'caviar';
    expect(() => parseGameData(r)).toThrow(/item inconnu "caviar"/);
  });

  it('valide palette, carte et décor de config.json', () => {
    expect(Object.keys(gameData.config.palette)).toHaveLength(8);
    expect(gameData.config.map.roads.length).toBeGreaterThan(0);
    expect(gameData.config.camera.type).toBe('perspective');
    expect(gameData.blocks.length).toBeGreaterThan(0);
  });

  it('refuse deux bâtiments qui se chevauchent', () => {
    const r = raw();
    const locs = r.locations as { blocks: { position: { x: number; z: number } }[] };
    locs.blocks[0]!.position = { x: -22.5, z: -15 }; // pile sur le local
    expect(() => parseGameData(r)).toThrow(/chevauche "local"|"local" chevauche/);
  });

  it('refuse un bâtiment sur la route', () => {
    const r = raw();
    const locs = r.locations as { locations: { position: { x: number; z: number } }[] };
    locs.locations[0]!.position = { x: -22.5, z: 0 };
    expect(() => parseGameData(r)).toThrow(/empiète sur une route/);
  });

  it('refuse un point de départ dans un bâtiment', () => {
    const r = raw();
    (r.config as { players: { spawn: { x: number; z: number } } }).players.spawn = {
      x: -22.5,
      z: -15,
    };
    expect(() => parseGameData(r)).toThrow(/spawn est dans un bâtiment/);
  });

  it('refuse une étagère qui vend un objet inconnu', () => {
    const r = raw();
    const shops = r.shops as { shops: { shelves: { itemId: string }[] }[] };
    shops.shops[0]!.shelves[0]!.itemId = 'caviar';
    expect(() => parseGameData(r)).toThrow(/objet "caviar" inconnu/);
  });

  it('charge les magasins avec prix et stock', () => {
    const grocery = gameData.shops.get('grocery')!;
    expect(grocery.shelves.map((s) => s.itemId).sort()).toEqual(['food', 'soda', 'water']);
    expect(
      gameData.shops.get('shop')!.shelves.find((s) => s.itemId === 'seed_base')!.price,
    ).toBeGreaterThan(0);
  });
});
