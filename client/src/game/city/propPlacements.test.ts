import { describe, expect, it } from 'vitest';
import { footprint, gameData, allPlacements, type Rect } from '@narco/shared';
import { BoxGeometry } from 'three';
import { blockModelHeights, mergedPropIds, propKitItems } from './propPlacements';
import { propSize } from './propAssets';
import { mergeInstances, type PropItem } from './PropKits';

/**
 * Décor importé : un modèle remplace la façade générée dans la même emprise (collisions
 * inchangées), voitures à la longueur de la config, props posés tous instanciés.
 */
const items = propKitItems(gameData);
const { kits } = gameData.placements;

/** Emprise monde (m) d'une instance : boîte du prop × échelle, quart de tour appliqué. */
function worldRect(id: string, it: PropItem): Rect {
  const s = propSize(gameData.props.get(id)!);
  const w = s.w * (it.sx ?? 1);
  const d = s.d * (it.sz ?? it.sx ?? 1);
  const turned = Math.abs(Math.round((it.rotY ?? 0) / (Math.PI / 2))) % 2 === 1;
  const [hw, hd] = turned ? [d / 2, w / 2] : [w / 2, d / 2];
  return { minX: it.x - hw, maxX: it.x + hw, minZ: it.z - hd, maxZ: it.z + hd };
}

function instancesOf(ids: readonly string[]): [string, PropItem][] {
  return ids.flatMap((id) => (items.get(id) ?? []).map((it): [string, PropItem] => [id, it]));
}

/** Le modèle tient dans l'emprise (jamais de débord) ; part de l'emprise couverte notée. */
const coverage: number[] = [];
const within = (a: Rect, b: Rect) => {
  for (const k of ['minX', 'minZ'] as const) expect(a[k]).toBeGreaterThanOrEqual(b[k] - 1e-6);
  for (const k of ['maxX', 'maxZ'] as const) expect(a[k]).toBeLessThanOrEqual(b[k] + 1e-6);
  coverage.push(((a.maxX - a.minX) * (a.maxZ - a.minZ)) / ((b.maxX - b.minX) * (b.maxZ - b.minZ)));
};
const { maxStretch } = gameData.config.props;

describe('décor importé dans la ville', () => {
  it('maisons : une par maison générée, dans son emprise, façade vers la rue', () => {
    const houses = [...gameData.quartierLayouts.values()].flatMap((l) => l.houses);
    const placed = instancesOf(kits.houses.props);
    expect(placed).toHaveLength(houses.length);
    for (const h of houses) {
      const cx = (h.rect.minX + h.rect.maxX) / 2;
      const cz = (h.rect.minZ + h.rect.maxZ) / 2;
      const hit = placed.find(([, it]) => it.x === cx && it.z === cz);
      expect(hit, h.id).toBeDefined();
      within(worldRect(hit![0], hit![1]), h.rect);
      // avant du modèle (+Z) tourné vers la rue : +X pour une maison à l'ouest de l'axe
      expect(Math.sin(hit![1].rotY!)).toBeCloseTo(h.side < 0 ? 1 : -1);
    }
  });

  it("tours et immeubles de remplissage : dans l'emprise du bloc, proportions naturelles", () => {
    for (const [style, kit] of [
      ['tower', kits.towers],
      ['filler', kits.fillers],
    ] as const) {
      const blocks = gameData.blocks.filter((b) => b.style === style);
      const placed = instancesOf(kit.props);
      expect(placed).toHaveLength(blocks.length);
      for (const b of blocks) {
        const hit = placed.find(([, it]) => it.x === b.position.x && it.z === b.position.z)!;
        within(worldRect(hit[0], hit[1]), footprint(b));
        const h = propSize(gameData.props.get(hit[0])!).h * hit[1].sy!;
        // hauteur naturelle du modèle : les enseignes générées s'y posent
        expect(blockModelHeights(gameData).get(b.id)).toBeCloseTo(h, 6);
      }
    }
  });

  it('voitures : longueur de config.decor.carSize, police à part', () => {
    const { length } = gameData.config.decor.carSize;
    for (const [id, it] of instancesOf([...kits.cars.props, ...kits.policeCars.props]))
      expect(propSize(gameData.props.get(id)!).d * it.sx!).toBeCloseTo(length, 3);
    expect(instancesOf(kits.policeCars.props)).toHaveLength(
      gameData.config.decor.cars.filter((c) => c.police).length,
    );
  });

  it('props posés : tous instanciés à leur position', () => {
    for (const p of allPlacements(gameData.placements))
      expect(
        items.get(p.prop)?.some((it) => it.x === p.x && it.z === p.z),
        p.prop,
      ).toBe(true);
  });
});

describe('proportions des bâtiments importés', () => {
  it(`échelle non uniforme bornée à ${maxStretch}, emprises bien couvertes`, () => {
    for (const kit of [kits.houses, kits.towers, kits.fillers])
      for (const [, it] of instancesOf(kit.props)) {
        const s = [it.sx!, it.sy!, it.sz!];
        expect(Math.max(...s) / Math.min(...s)).toBeLessThanOrEqual(maxStretch + 1e-9);
      }
    const mean = coverage.reduce((a, b) => a + b, 0) / coverage.length;
    console.info(
      `emprise couverte : moyenne ${(mean * 100).toFixed(0)} %, min ${(Math.min(...coverage) * 100).toFixed(0)} %`,
    );
    expect(mean).toBeGreaterThan(0.7);
  });
});

describe("façade importée d'un lieu et props posés fusionnés", () => {
  it("la façade de l'épicerie est posée sur le lieu, tenue dans son emprise, une seule fois", () => {
    const loc = gameData.locations.get('epicerie')!;
    const placed = items.get('epicerie_batiment') ?? [];
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ x: loc.position.x, z: loc.position.z, rotY: 0 });
    within(worldRect('epicerie_batiment', placed[0]!), footprint(loc));
  });

  it('props posés sans atlas, découpe ni néon fusionnés ; ceux des kits restent instanciés', () => {
    const merged = mergedPropIds(gameData);
    for (const id of [
      'epicerie_etal',
      'epicerie_bouteilles',
      'epicerie_poubelle',
      'epicerie_cartons',
    ])
      expect(merged.has(id), id).toBe(true);
    for (const id of ['epicerie_batiment', 'bush', 'trash']) expect(merged.has(id), id).toBe(false);
  });

  it('fusion : géométries placées en monde, sommets additionnés', () => {
    const box = new BoxGeometry(1, 1, 1).toNonIndexed();
    const merged = mergeInstances([
      { geometry: box, item: { x: 10, z: 0 } },
      { geometry: box, item: { x: -10, z: 5, rotY: Math.PI / 2, sx: 2 } },
    ])!;
    expect(merged.attributes.position!.count).toBe(2 * box.attributes.position!.count);
    merged.computeBoundingBox();
    expect(merged.boundingBox!.max.x).toBeCloseTo(10.5);
    expect(merged.boundingBox!.min.x).toBeCloseTo(-11);
    expect(mergeInstances([])).toBeNull();
  });
});
