import { areaAt, areaRects } from './areas';
import type { GameData } from './data';
import { rectFromCenter, type Rect, type Vec2 } from './geometry';
import { footprint, visibleLocations } from './locations';

/**
 * Brouillard de guerre de la mini-carte : chaque joueur découvre les areas et les lieux notables
 * en passant à moins de `config.discovery.radius` mètres. Ids préfixés (`area:…`, `place:…`).
 * Les lieux cachés (trappe) et les jardins ne sont jamais des cibles : jamais d'icône.
 */

export const AREA_PREFIX = 'area:';
export const PLACE_PREFIX = 'place:';

export interface DiscoveryTarget {
  id: string;
  kind: 'area' | 'place';
  rects: Rect[];
  /** Pictogramme affiché une fois découvert (lieux seulement). */
  icon?: string;
  /** Point d'ancrage de l'icône sur la carte. */
  at: Vec2;
}

type MapData = Pick<GameData, 'areas' | 'locations' | 'blocks' | 'config'>;

const cache = new WeakMap<object, DiscoveryTarget[]>();

/** Areas, lieux visibles à pictogramme et repères à pictogramme (blocs), dans cet ordre. */
export function discoveryTargets(data: MapData): DiscoveryTarget[] {
  const hit = cache.get(data.areas);
  if (hit) return hit;
  const out: DiscoveryTarget[] = [];
  for (const a of data.areas.values()) {
    const b = a.bounds;
    out.push({
      id: AREA_PREFIX + a.id,
      kind: 'area',
      rects: areaRects(a),
      at: { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 },
    });
  }
  for (const loc of visibleLocations(data.locations.values()))
    if (loc.icon)
      out.push({
        id: PLACE_PREFIX + loc.id,
        kind: 'place',
        rects: [footprint(loc)],
        icon: loc.icon,
        at: loc.position,
      });
  for (const b of data.blocks)
    if (b.icon)
      out.push({
        id: PLACE_PREFIX + b.id,
        kind: 'place',
        rects: [rectFromCenter(b.position, b.size)],
        icon: b.icon,
        at: b.position,
      });
  cache.set(data.areas, out);
  return out;
}

function rectDistance(r: Rect, p: Vec2): number {
  const dx = Math.max(r.minX - p.x, 0, p.x - r.maxX);
  const dz = Math.max(r.minZ - p.z, 0, p.z - r.maxZ);
  return Math.hypot(dx, dz);
}

/** Cibles à portée de `p` pas encore connues (ids), dans l'ordre des cibles. */
export function discoverAt(data: MapData, p: Vec2, known: ReadonlySet<string>): string[] {
  const { radius } = data.config.discovery;
  return discoveryTargets(data)
    .filter((t) => !known.has(t.id) && t.rects.some((r) => rectDistance(r, p) <= radius))
    .map((t) => t.id);
}

/**
 * Découverte d'un joueur sans historique (nouveau joueur, ancienne sauvegarde) : l'area du
 * départ seule (`config.players.spawn`).
 */
export function initialDiscovery(data: MapData): string[] {
  const start = areaAt(data.areas.values(), data.config.players.spawn);
  return start ? [AREA_PREFIX + start.id] : [];
}

/** Ids connus d'un type. */
export function discoveredAreaIds(ids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const id of ids) if (id.startsWith(AREA_PREFIX)) out.add(id.slice(AREA_PREFIX.length));
  return out;
}

/** Tout révéler (debug). */
export function allDiscoveryIds(data: MapData): string[] {
  return discoveryTargets(data).map((t) => t.id);
}
