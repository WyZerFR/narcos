import { describe, expect, it } from 'vitest';
import {
  footprint,
  gameData,
  allPlacements,
  streetlightPlacements,
  type Rect,
} from '@narco/shared';
import { BoxGeometry } from 'three';
import { blockModelHeights, mergedFacadeIds, mergedPropIds, propKitItems } from './propPlacements';
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
    for (const id of ['banque_distributeur', 'banque_bac_arbuste', 'banque_haie'])
      expect(merged.has(id), id).toBe(true);
  });

  it('façades importées et bâtiments posés une fois fusionnés entre eux, pas avec les props', () => {
    const facades = mergedFacadeIds(gameData);
    expect([...facades].sort()).toEqual([
      'armurerie_batiment',
      'banque_batiment',
      'barbier_batiment',
      'concession_batiment',
      'epicerie_batiment',
      'hangar_cargo',
      'hangar_regional',
      'labo_batiment',
      'laverie_batiment',
      'police_batiment',
      'quartier_coin',
      'quartier_normal',
      'superette_batiment',
    ]);
    const merged = mergedPropIds(gameData);
    for (const id of facades) expect(merged.has(id), id).toBe(false);
    const loc = gameData.locations.get('banque')!;
    const placed = items.get('banque_batiment') ?? [];
    expect(placed).toHaveLength(1);
    within(worldRect('banque_batiment', placed[0]!), footprint(loc));
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

describe('tours modélisées (bulding)', () => {
  it('les trois tours remplacent trois tours Kenney du kit, chacune posée au moins une fois', () => {
    const ids = ['tour_beige', 'tour_brique', 'tour_verre'];
    for (const id of ids) {
      expect(kits.towers.props, id).toContain(id);
      expect(gameData.props.get(id)?.cuttable, id).toBe(true);
      expect((items.get(id) ?? []).length, id).toBeGreaterThan(0);
    }
    expect(kits.towers.props).toHaveLength(4);
  });

  it('leurs props au sol, sans texture, rejoignent le draw call fusionné', () => {
    const merged = mergedPropIds(gameData);
    for (const id of ['tour_bac_arbuste', 'tour_borne_incendie', 'tour_boites_lettres'])
      expect(merged.has(id), id).toBe(true);
  });
});

describe('assemblage : voitures, avions, hangars', () => {
  it('voitures civiles teintées par instance, police à livrée, mêmes emplacements', () => {
    for (const id of kits.cars.props) expect(gameData.props.get(id)?.paint, id).toBe(true);
    for (const id of kits.policeCars.props)
      expect(gameData.props.get(id)?.paint, id).toBeUndefined();
    const police = instancesOf(kits.policeCars.props);
    expect(police).toHaveLength(gameData.config.decor.cars.filter((c) => c.police).length);
    expect(gameData.config.props.paints.length).toBeGreaterThan(3);
  });

  it('avions : un par emplacement, au plus à taille réelle, tenus dans la longueur générée', () => {
    const planes = instancesOf(kits.planes.props);
    expect(planes).toHaveLength(gameData.config.airport.planes.length);
    expect(new Set(planes.map(([id]) => id)).size).toBe(kits.planes.props.length);
    const { length } = gameData.config.airport.planeSize;
    for (const [id, it] of planes) {
      expect(it.sx, id).toBeLessThanOrEqual(1);
      const s = propSize(gameData.props.get(id)!);
      expect(s.d * (it.sx ?? 1), id).toBeLessThanOrEqual(length + 1e-6);
    }
  });

  it('hangars : un modèle par hangar généré, dans son emprise, porte vers la piste', () => {
    const hangars = instancesOf(kits.hangars.props);
    expect(hangars.map(([id]) => id).sort()).toEqual(['hangar_cargo', 'hangar_regional']);
    const rects = gameData.config.airport.hangars;
    for (const [id, it] of hangars) {
      const h = rects.find((r) => r.x === it.x && r.z === it.z)!;
      within(worldRect(id, it), {
        minX: h.x - h.w / 2,
        maxX: h.x + h.w / 2,
        minZ: h.z - h.d / 2,
        maxZ: h.z + h.d / 2,
      });
      // grande porte (+Z du modèle) tournée vers la piste (même face que le hangar généré)
      const rw = gameData.config.airport.runway;
      const door = { x: Math.sin(it.rotY ?? 0), z: Math.cos(it.rotY ?? 0) };
      expect(door.x * (rw.x - it.x) + door.z * (rw.z - it.z), id).toBeGreaterThan(0);
    }
    // fusionnés : aucun InstancedMesh propre
    const facades = mergedFacadeIds(gameData);
    const merged = mergedPropIds(gameData);
    for (const id of kits.hangars.props) expect(facades.has(id), id).toBe(true);
    for (const id of kits.planes.props) expect(merged.has(id), id).toBe(true);
  });
});

describe('assemblage : lampadaires, poubelles, arbres', () => {
  it('un modèle par décor généré remplacé, aux mêmes positions', () => {
    const layouts = [...gameData.quartierLayouts.values()];
    const street = streetlightPlacements(gameData);
    expect(instancesOf(kits.lamps.props)).toHaveLength(street.length);
    for (const [, it] of instancesOf(kits.lamps.props))
      expect(street.some((l) => l.x === it.x && l.z === it.z)).toBe(true);
    expect(instancesOf(kits.quartierLamps.props)).toHaveLength(
      layouts.reduce((n, l) => n + l.lamps.length, 0),
    );
    const bins =
      gameData.config.decor.bins.length +
      layouts.reduce(
        (n, l) => n + l.bins.length + l.gardens.reduce((m, g) => m + g.bins.length, 0),
        0,
      );
    expect(instancesOf(kits.bins.props)).toHaveLength(bins);
    for (const id of kits.trees.props) expect(id).toMatch(/^objet_arbre_/);
  });
});
