import { describe, expect, it } from 'vitest';
import { footprint, gameData, allPlacements, type Rect } from '@narco/shared';
import { propKitItems } from './propPlacements';
import { propSize } from './propAssets';
import type { PropItem } from './PropKits';

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

const close = (a: Rect, b: Rect) => {
  for (const k of ['minX', 'maxX', 'minZ', 'maxZ'] as const) expect(a[k]).toBeCloseTo(b[k], 3);
};

describe('décor importé dans la ville', () => {
  it('maisons : une par maison générée, dans son emprise exacte, façade vers la rue', () => {
    const houses = [...gameData.quartierLayouts.values()].flatMap((l) => l.houses);
    const placed = instancesOf(kits.houses.props);
    expect(placed).toHaveLength(houses.length);
    for (const h of houses) {
      const cx = (h.rect.minX + h.rect.maxX) / 2;
      const cz = (h.rect.minZ + h.rect.maxZ) / 2;
      const hit = placed.find(([, it]) => it.x === cx && it.z === cz);
      expect(hit, h.id).toBeDefined();
      close(worldRect(hit![0], hit![1]), h.rect);
      // avant du modèle (+Z) tourné vers la rue : +X pour une maison à l'ouest de l'axe
      expect(Math.sin(hit![1].rotY!)).toBeCloseTo(h.side < 0 ? 1 : -1);
    }
  });

  it('tours et immeubles de remplissage : emprise et hauteur du bloc', () => {
    for (const [style, kit] of [
      ['tower', kits.towers],
      ['filler', kits.fillers],
    ] as const) {
      const blocks = gameData.blocks.filter((b) => b.style === style);
      const placed = instancesOf(kit.props);
      expect(placed).toHaveLength(blocks.length);
      for (const b of blocks) {
        const hit = placed.find(([, it]) => it.x === b.position.x && it.z === b.position.z)!;
        close(worldRect(hit[0], hit[1]), footprint(b));
        const h = propSize(gameData.props.get(hit[0])!).h * hit[1].sy!;
        expect(h).toBeCloseTo(b.height * kit.heightScale, 3);
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
