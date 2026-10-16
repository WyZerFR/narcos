import {
  allPlacements,
  footprint,
  greeneryLayout,
  lotCars,
  type GameData,
  type PropKitId,
  type Rect,
} from '@narco/shared';
import { propSize } from './propAssets';
import type { PropItem } from './PropKits';

/** Emplacement d'un décor généré : centre au sol, rotation Y, cible d'ajustement (m). */
interface Spot {
  x: number;
  z: number;
  rotY: number;
  /** `box` : emprise monde (w le long de X, d le long de Z) et hauteur. */
  box?: { w: number; h: number; d: number };
  /** `height` : échelle uniforme du décor généré (arbres). */
  scale?: number;
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const turned = (rotY: number) => Math.abs(Math.round(rotY / (Math.PI / 2))) % 2 === 1;
const boxOf = (r: Rect, h: number) => ({ w: r.maxX - r.minX, h, d: r.maxZ - r.minZ });

/** Emplacements du décor généré, par kit remplaçable (mêmes positions que `Decor`). */
function spots(data: GameData, kit: PropKitId): Spot[] {
  const { decor } = data.config;
  const layouts = [...data.quartierLayouts.values()];
  switch (kit) {
    case 'trees':
      return [
        ...decor.trees.map((t, i) => ({ x: t.x, z: t.z, rotY: i, scale: t.scale })),
        ...layouts.flatMap((l) => l.trees).map((t, i) => ({ ...t, rotY: i + decor.trees.length })),
        ...greeneryLayout(data).trees.map((t, i) => ({ ...t, rotY: i * 2.1 })),
      ];
    case 'bushes':
      return greeneryLayout(data).bushes.map((b, i) => ({ ...b, rotY: i * 1.7 }));
    case 'palms':
      return data.island.palms.map((p, i) => ({ x: p.x, z: p.z, rotY: i * 1.3 }));
    case 'cars':
      return [
        ...decor.cars
          .filter((c) => !c.police)
          .map((c) => ({ x: c.x, z: c.z, rotY: c.rotation === 90 ? Math.PI / 2 : 0 })),
        ...layouts.flatMap((l) => l.cars.map((c) => ({ x: c.x, z: c.z, rotY: c.rotY }))),
        ...data.blocks
          .filter((b) => b.style === 'dealership' || b.style === 'parking')
          .flatMap((b) => lotCars(b, decor.carSize, data.config.city.lotCars)),
      ];
    case 'policeCars':
      return decor.cars
        .filter((c) => c.police)
        .map((c) => ({ x: c.x, z: c.z, rotY: c.rotation === 90 ? Math.PI / 2 : 0 }));
    case 'houses':
      // façade vers la rue : côté ouest de l'axe → façade est (+X), et inversement
      return layouts.flatMap((l) =>
        l.houses.map((h) => ({
          x: (h.rect.minX + h.rect.maxX) / 2,
          z: (h.rect.minZ + h.rect.maxZ) / 2,
          rotY: h.side < 0 ? Math.PI / 2 : -Math.PI / 2,
          box: boxOf(h.rect, h.height),
        })),
      );
    case 'towers':
    case 'fillers':
      return data.blocks
        .filter((b) => b.style === (kit === 'towers' ? 'tower' : 'filler'))
        .map((b) => ({
          x: b.position.x,
          z: b.position.z,
          rotY: 0,
          box: boxOf(footprint(b), b.height),
        }));
  }
}

/**
 * Instances du décor importé, par id de prop : décor généré remplacé (`placements.kits`, props
 * tirés en alternance, ajustés à l'emprise générée : collisions inchangées) et props posés
 * (`placements.areas`).
 */
export function propKitItems(data: GameData): Map<string, PropItem[]> {
  const out = new Map<string, PropItem[]>();
  const push = (id: string, it: PropItem) => {
    const list = out.get(id);
    if (list) list.push(it);
    else out.set(id, [it]);
  };
  const { carSize } = data.config.decor;
  for (const [kit, cfg] of Object.entries(data.placements.kits) as [
    PropKitId,
    (typeof data.placements.kits)[PropKitId],
  ][]) {
    if (cfg.props.length === 0) continue;
    spots(data, kit).forEach((s, i) => {
      const id = cfg.props[i % cfg.props.length]!;
      const prop = data.props.get(id);
      if (!prop) return;
      const size = propSize(prop);
      const rotY = s.rotY + rad(cfg.rotationY);
      if (cfg.fit === 'box' && s.box) {
        const t = turned(rotY);
        push(id, {
          x: s.x,
          z: s.z,
          rotY,
          sx: (t ? s.box.d : s.box.w) / size.w,
          sy: (s.box.h * cfg.heightScale) / size.h,
          sz: (t ? s.box.w : s.box.d) / size.d,
        });
      } else if (cfg.fit === 'length')
        push(id, { x: s.x, z: s.z, rotY, sx: carSize.length / size.d });
      else push(id, { x: s.x, z: s.z, rotY, sx: (s.scale ?? 1) * cfg.heightScale });
    });
  }
  for (const p of allPlacements(data.placements))
    push(p.prop, { x: p.x, z: p.z, rotY: rad(p.rotation), sx: p.scale });
  return out;
}
