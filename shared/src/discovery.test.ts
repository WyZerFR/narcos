import { describe, expect, it } from 'vitest';
import { gameData } from './data';
import {
  allDiscoveryIds,
  AREA_PREFIX,
  discoverAt,
  discoveredAreaIds,
  discoveryTargets,
  initialDiscovery,
  PLACE_PREFIX,
} from './discovery';
import { footprint } from './locations';
import { rectContainsPoint } from './geometry';

const { radius } = gameData.config.discovery;
const none = new Set<string>();

describe('brouillard de guerre', () => {
  it("départ : l'area du carton seule", () => {
    expect(initialDiscovery(gameData)).toEqual([AREA_PREFIX + 'bas_fonds']);
  });

  it('un lieu se révèle dans le rayon, pas au-delà', () => {
    const bank = footprint(gameData.locations.get('banque')!);
    const near = { x: bank.maxX + radius - 0.5, z: (bank.minZ + bank.maxZ) / 2 };
    const far = { x: bank.maxX + radius + 0.5, z: near.z };
    expect(discoverAt(gameData, near, none)).toContain(PLACE_PREFIX + 'banque');
    expect(discoverAt(gameData, far, none)).not.toContain(PLACE_PREFIX + 'banque');
  });

  it("une area se révèle de l'intérieur ; déjà connue, rien de neuf", () => {
    const inside = gameData.locations.get('repaire_jefe')!.position;
    const found = discoverAt(gameData, inside, none);
    expect(found).toContain(AREA_PREFIX + 'cartel');
    expect(discoverAt(gameData, inside, new Set(found))).toEqual([]);
    expect(discoveredAreaIds(found).has('cartel')).toBe(true);
  });

  it("aucun lieu caché ni jardin : jamais de cible, jamais d'icône", () => {
    const ids = allDiscoveryIds(gameData);
    const hidden = [...gameData.locations.values()].filter((l) => l.hidden);
    expect(hidden.length).toBeGreaterThan(0);
    for (const loc of hidden) expect(ids).not.toContain(PLACE_PREFIX + loc.id);
    const gardens = [...gameData.quartierLayouts.values()].flatMap((l) =>
      l.gardens.flatMap((g) => [g.garden, g.passage]),
    );
    for (const t of discoveryTargets(gameData).filter((x) => x.kind === 'place'))
      for (const g of gardens) expect(rectContainsPoint(g, t.at), t.id).toBe(false);
    // debout sur la trappe : elle ne se révèle jamais
    for (const loc of hidden)
      expect(discoverAt(gameData, loc.position, none).some((id) => id.includes(loc.id))).toBe(
        false,
      );
  });

  it('seuls les lieux notables ont une icône (banque, armurerie, repaire, concession, laverie)', () => {
    const icons = discoveryTargets(gameData).filter((t) => t.kind === 'place');
    for (const t of icons) expect(t.icon).toBeTruthy();
    const ids = icons.map((t) => t.id.slice(PLACE_PREFIX.length));
    for (const id of ['banque', 'repaire_jefe', 'co_milieu', 'co_bras_milieu', 'co_ouest'])
      expect(ids).toContain(id);
    expect(ids).not.toContain('ruelle_nord');
  });
});
