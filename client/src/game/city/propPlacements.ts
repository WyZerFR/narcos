import {
  allPlacements,
  facadePlacements,
  footprint,
  greeneryLayout,
  hasFacade,
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
          .filter(
            (b) => (b.style === 'dealership' || b.style === 'parking') && !hasFacade(data, b.id),
          )
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
      const rotY = s.rotY + rad(cfg.rotationY);
      if (cfg.fit === 'box' && s.box) {
        const fit = fitBox(data, cfg.props, s.box, rotY, cfg.heightScale, i);
        if (fit) push(fit.id, { x: s.x, z: s.z, rotY, sx: fit.sx, sy: fit.sy, sz: fit.sz });
        return;
      }
      const id = cfg.props[i % cfg.props.length]!;
      const prop = data.props.get(id);
      if (!prop) return;
      const size = propSize(prop);
      if (cfg.fit === 'length') push(id, { x: s.x, z: s.z, rotY, sx: carSize.length / size.d });
      else push(id, { x: s.x, z: s.z, rotY, sx: (s.scale ?? 1) * cfg.heightScale });
    });
  }
  for (const p of allPlacements(data.placements))
    push(p.prop, { x: p.x, z: p.z, rotY: rad(p.rotation), sx: p.scale });
  for (const f of facadePlacements(data)) push(f.prop, { x: f.x, z: f.z, rotY: rad(f.rotation) });
  return out;
}

/**
 * Props fusionnés en un seul draw call (`MergedProps`) : posés seulement à la main
 * (`placements.areas`, ni kit ni façade), sans atlas ni découpe (même matériau, néons compris).
 */
export function mergedPropIds(data: GameData): Set<string> {
  const elsewhere = new Set([
    ...Object.values(data.placements.kits).flatMap((k) => k.props),
    ...Object.values(data.placements.facades),
  ]);
  const out = new Set<string>();
  for (const p of allPlacements(data.placements)) {
    const prop = data.props.get(p.prop);
    if (prop && !elsewhere.has(p.prop) && !prop.texture && !prop.cuttable) out.add(p.prop);
  }
  return out;
}

/**
 * Façades importées fusionnées en un seul draw call (découpe et néons gardés) : chacune n'est
 * posée qu'une fois (façade, ou bâtiment décoratif posé à la main comme la supérette), sans
 * atlas ni kit.
 */
export function mergedFacadeIds(data: GameData): Set<string> {
  const kits = new Set(Object.values(data.placements.kits).flatMap((k) => k.props));
  const uses = new Map<string, number>();
  for (const id of [
    ...Object.values(data.placements.facades),
    ...allPlacements(data.placements).map((p) => p.prop),
  ])
    uses.set(id, (uses.get(id) ?? 0) + 1);
  const out = new Set<string>();
  for (const [id, n] of uses) {
    const prop = data.props.get(id);
    if (prop && n === 1 && !kits.has(id) && !prop.texture && prop.cuttable) out.add(id);
  }
  return out;
}

/** Ajustement d'un bâtiment importé dans une emprise : modèle retenu et échelles par axe. */
export interface BoxFit {
  id: string;
  sx: number;
  sy: number;
  sz: number;
}

/**
 * Proportions naturelles : parmi les props du kit, celui dont le rapport largeur / profondeur
 * colle le mieux à l'emprise (en alternance entre les quasi-ex æquo), échelle uniforme qui
 * tient dans l'emprise, puis chaque axe étiré d'au plus `config.props.maxStretch` vers
 * l'emprise et la hauteur voulue : jamais de déformation visible.
 */
export function fitBox(
  data: GameData,
  ids: readonly string[],
  box: { w: number; h: number; d: number },
  rotY: number,
  heightScale: number,
  index: number,
): BoxFit | null {
  const t = turned(rotY);
  const lw = t ? box.d : box.w;
  const ld = t ? box.w : box.d;
  const scored = ids.flatMap((id) => {
    const prop = data.props.get(id);
    if (!prop) return [];
    const s = propSize(prop);
    return [{ id, s, err: Math.abs(Math.log(lw / ld / (s.w / s.d))) }];
  });
  if (scored.length === 0) return null;
  const best = Math.min(...scored.map((c) => c.err));
  const near = scored.filter((c) => c.err <= best + 0.1);
  const { id, s } = near[index % near.length]!;
  const k = data.config.props.maxStretch;
  const s0 = Math.min(lw / s.w, ld / s.d);
  const clamp = (v: number) => Math.min(Math.max(v, s0), s0 * k);
  return { id, sx: clamp(lw / s.w), sy: clamp((box.h * heightScale) / s.h), sz: clamp(ld / s.d) };
}

const heights = new WeakMap<GameData, Map<string, number>>();

/**
 * Hauteur réelle (m) des blocs dont la façade est importée (tours, remplissage) : les enseignes
 * générées se posent au sommet du modèle, pas à la hauteur du bloc.
 */
export function blockModelHeights(data: GameData): Map<string, number> {
  let out = heights.get(data);
  if (out) return out;
  out = new Map();
  for (const kit of ['towers', 'fillers'] as const) {
    const cfg = data.placements.kits[kit];
    if (cfg.props.length === 0) continue;
    data.blocks
      .filter((b) => b.style === (kit === 'towers' ? 'tower' : 'filler'))
      .forEach((b, i) => {
        const r = footprint(b);
        const box = { w: r.maxX - r.minX, h: b.height, d: r.maxZ - r.minZ };
        const fit = fitBox(data, cfg.props, box, rad(cfg.rotationY), cfg.heightScale, i);
        if (fit) out!.set(b.id, propSize(data.props.get(fit.id)!).h * fit.sy);
      });
  }
  heights.set(data, out);
  return out;
}
