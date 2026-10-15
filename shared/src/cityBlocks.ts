import type { Rect, Vec2 } from './geometry';
import { footprint } from './locations';
import { seededRng } from './quartiers';
import type { Block, CityParams } from './schemas';

/**
 * Centre-ville et commerces (logique pure, déterministe) : découpe des îlots `tower_lot` en
 * tours contiguës (l'union des tours = l'emprise de l'îlot, donc mêmes collisions et mêmes
 * trajets) et voitures rangées dans l'emprise d'une concession ou d'un parking.
 */

/** Découpe un îlot en tours le long de son grand côté (largeurs, hauteurs, enseignes tirées). */
export function generateTowers(lot: Block, p: CityParams['towers']): Block[] {
  const rng = seededRng(`${p.seed}:${lot.id}`);
  const r = footprint(lot);
  const alongX = lot.size.w >= lot.size.d;
  const length = alongX ? lot.size.w : lot.size.d;
  // largeurs entre min et max ; le reste trop court est rendu à la dernière tour
  const widths: number[] = [];
  let left = length;
  while (left > 0) {
    const w = Math.min(left, p.minWidth + rng() * (p.maxWidth - p.minWidth));
    if (left - w < p.minWidth && left - w > 0) {
      widths.push(left);
      break;
    }
    widths.push(w);
    left -= w;
  }
  const [hMin, hMax] = p.heights;
  let start = alongX ? r.minX : r.minZ;
  return widths.map((w, i) => {
    const mid = start + w / 2;
    start += w;
    const signed = rng() < p.signChance;
    const tower: Block = {
      id: widths.length === 1 ? lot.id : `${lot.id}_${i}`,
      position: alongX ? { x: mid, z: lot.position.z } : { x: lot.position.x, z: mid },
      size: alongX ? { w, d: lot.size.d } : { w: lot.size.w, d: w },
      height: Math.round(hMin + rng() * (hMax - hMin)),
      style: 'tower',
      neonColor: p.neonColors[Math.floor(rng() * p.neonColors.length)]!,
    };
    if (lot.color) tower.color = lot.color;
    if (signed) tower.sign = p.signs[Math.floor(rng() * p.signs.length)]!;
    return tower;
  });
}

/** Immeubles du jeu : les îlots de tours remplacés par leurs tours, les autres inchangés. */
export function expandBlocks(blocks: readonly Block[], p: CityParams['towers']): Block[] {
  return blocks.flatMap((b) => (b.style === 'tower_lot' ? generateTowers(b, p) : [b]));
}

/** Une voiture rangée : centre, orientation (0 = le long de X) et indice de teinte. */
export interface LotCar extends Vec2 {
  rotY: number;
  tint: number;
}

/**
 * Voitures en rangées dans l'emprise (`margin` au bord, `gap` entre deux) : capot vers le grand
 * côté, une place sur `fillChance` occupée. Décor seulement : l'emprise est déjà un obstacle.
 */
export function lotCars(
  block: Block,
  car: { length: number; width: number },
  p: CityParams['lotCars'],
): LotCar[] {
  const rng = seededRng(`${p.seed}:${block.id}`);
  const r: Rect = footprint(block);
  const inner = {
    minX: r.minX + p.margin,
    maxX: r.maxX - p.margin,
    minZ: r.minZ + p.margin,
    maxZ: r.maxZ - p.margin,
  };
  // voitures perpendiculaires au grand côté : rangées le long du grand côté
  const alongX = block.size.w >= block.size.d;
  const slot = car.width + p.gap;
  const depth = car.length + p.gap;
  const span = alongX ? inner.maxX - inner.minX : inner.maxZ - inner.minZ;
  const across = alongX ? inner.maxZ - inner.minZ : inner.maxX - inner.minX;
  const cols = Math.floor((span + p.gap) / slot);
  const rows = Math.floor((across + p.gap) / depth);
  const out: LotCar[] = [];
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      if (rng() >= p.fillChance) continue;
      const u = (alongX ? inner.minX : inner.minZ) + (span - cols * slot + p.gap) / 2 + i * slot;
      const v =
        (alongX ? inner.minZ : inner.minX) + (across - rows * depth + p.gap) / 2 + j * depth;
      const cu = u + car.width / 2;
      const cv = v + car.length / 2;
      out.push({
        x: alongX ? cu : cv,
        z: alongX ? cv : cu,
        rotY: alongX ? Math.PI / 2 : 0,
        tint: Math.floor(rng() * 1000),
      });
    }
  return out;
}
