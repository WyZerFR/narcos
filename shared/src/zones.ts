import { obstaclesFrom, type MapData } from './collision';
import { nearestPlace, type Place } from './fixtures';
import type { GameData } from './data';
import { distance, rectFromCenter, rectGap, type Rect, type Vec2 } from './geometry';
import type { GameLocation, Interior, Station } from './schemas';

/**
 * Zones de jeu : la rue (carte du quartier) ou un intérieur (`zones.json`). Chaque joueur est
 * dans exactement une zone ; mouvements, collisions et interactions dépendent de celle-ci.
 * (À ne pas confondre avec les quartiers zone1/2/3 de `locations.json`.)
 */
export const STREET = 'street';

/** Bornes de déplacement dans un intérieur (pièce centrée sur l'origine). */
export function interiorBounds(interior: Interior): Rect {
  return rectFromCenter({ x: 0, z: 0 }, interior.size);
}

/** Obstacles d'un intérieur : obstacles déclarés + postes solides. */
export function interiorObstacles(interior: Interior): Rect[] {
  return [
    ...interior.obstacles.map((o) => rectFromCenter(o, o)),
    ...interior.stations.filter((s) => s.solid).map((s) => rectFromCenter(s.position, s.size)),
    ...interior.props.filter((p) => p.solid).map((p) => rectFromCenter(p.position, p.size)),
  ];
}

export interface ZoneArea {
  bounds: Rect;
  obstacles: Rect[];
}

/** Bornes + obstacles de la zone (rue ou intérieur). `null` si la zone est inconnue. */
export function zoneArea(
  data: MapData & Pick<GameData, 'interiors'>,
  zoneId: string,
  /** Obstacles dynamiques en plus (mobilier installé). */
  extra: readonly Rect[] = [],
): ZoneArea | null {
  if (zoneId === STREET)
    return { bounds: data.config.world.bounds, obstacles: obstaclesFrom(data) };
  const interior = data.interiors.get(zoneId);
  return interior
    ? { bounds: interiorBounds(interior), obstacles: [...interiorObstacles(interior), ...extra] }
    : null;
}

/** Intérieur auquel mène la porte d'un lieu de la rue, s'il y en a un. */
export function interiorForLocation(
  data: Pick<GameData, 'interiors'>,
  locationId: string,
): Interior | undefined {
  for (const interior of data.interiors.values()) {
    if (interior.entranceLocationId === locationId) return interior;
  }
  return undefined;
}

/** Poste le plus proche dont le rayon d'interaction contient `pos` (ou null). */
export function nearestStation(pos: Vec2, interior: Interior, tolerance = 0): Station | null {
  let best: Station | null = null;
  let bestDist = Infinity;
  for (const station of interior.stations) {
    const d = distance(pos, station.position);
    if (d <= station.interactRadius + tolerance && d < bestDist) {
      best = station;
      bestDist = d;
    }
  }
  return best;
}

/** Ce que fait le bouton ACTION devant un lieu de la rue : entrer, parler, ou rien (repère). */
export type LocationInteraction = 'enter' | 'talk';

/**
 * Interaction d'un lieu : `enter` s'il mène à un intérieur, `talk` s'il porte un dialogue,
 * null sinon (ruelle, point relais… : simple repère, aucun bouton ACTION).
 */
export function locationInteraction(
  data: Pick<GameData, 'interiors'>,
  loc: Pick<GameLocation, 'id' | 'dialogue'>,
): LocationInteraction | null {
  if (interiorForLocation(data, loc.id)) return 'enter';
  if (loc.dialogue) return 'talk';
  return null;
}

/**
 * Hystérésis d'interaction : on entre dans le rayon d'un poste à `interactRadius`, on n'en sort
 * qu'à `interactRadius + exitMargin` (bouton ACTION qui ne clignote pas, panneaux qui restent
 * ouverts à la limite du rayon).
 */
export function inInteractRange(
  pos: Vec2,
  target: { position: Vec2; interactRadius: number },
  wasInside: boolean,
  exitMargin: number,
): boolean {
  return distance(pos, target.position) <= target.interactRadius + (wasInside ? exitMargin : 0);
}

/** Endroit visé avec hystérésis : `currentId` reste choisi tant qu'on est dans son rayon de sortie. */
export function stickyNearest(
  pos: Vec2,
  places: readonly Place[],
  currentId: string | null,
  exitMargin: number,
): Place | null {
  const fresh = nearestPlace(pos, places);
  const current = currentId ? places.find((p) => p.id === currentId) : undefined;
  if (!current || !inInteractRange(pos, current, true, exitMargin)) return fresh;
  // une lampe retenue cède la place à un meuble au sol (le pot dessous) dès qu'il est à portée
  const ceiling = current.fixture?.mount === 'ceiling';
  return ceiling && fresh && fresh.fixture?.mount !== 'ceiling' ? fresh : current;
}

/**
 * Applique `layoutScale` à un intérieur. Les meubles solides qui se touchent (rangée
 * d'étagères) bougent d'un bloc : le centre du bloc est agrandi, les écarts internes restent
 * nuls. Un bloc qui finirait à moins de `minGap` d'un mur y est plaqué (pas de fente où se
 * coincer). La sortie reste contre le mur de la porte (+z) ; le reste est agrandi tel quel.
 */
export function scaleInterior(interior: Interior, minGap: number): Interior {
  const k = interior.layoutScale;
  if (k === 1) return interior;
  const size = { w: interior.size.w * k, d: interior.size.d * k };
  const hw = size.w / 2;
  const hd = size.d / 2;
  const scale = (p: Vec2) => ({ x: p.x * k, z: p.z * k });

  // meubles solides (postes, décor) et blocs de meubles qui se touchent
  type Item = { rect: Rect; move: (d: Vec2) => void };
  const stations = interior.stations.map((s) => ({ ...s, position: { ...s.position } }));
  const props = interior.props.map((p) => ({ ...p, position: { ...p.position } }));
  const items: Item[] = [...stations, ...props]
    .filter((m) => m.solid && !('kind' in m && m.kind === 'exit'))
    .map((m) => ({
      rect: rectFromCenter(m.position, m.size),
      move: (d: Vec2) => {
        m.position.x += d.x;
        m.position.z += d.z;
      },
    }));
  const group = items.map((_, i) => i);
  const root = (i: number): number => (group[i] === i ? i : (group[i] = root(group[i]!)));
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++)
      if (rectGap(items[i]!.rect, items[j]!.rect) <= 1e-6) group[root(i)] = root(j);
  const blocks = new Map<number, Item[]>();
  items.forEach((it, i) => blocks.set(root(i), [...(blocks.get(root(i)) ?? []), it]));
  // écart au mur le plus proche ramené à zéro s'il ne laisse pas un vrai passage
  const snap = (min: number, max: number, half: number) =>
    min + half > 1e-6 && min + half < minGap
      ? -half - min
      : half - max > 1e-6 && half - max < minGap
        ? half - max
        : 0;
  for (const members of blocks.values()) {
    const box = {
      minX: Math.min(...members.map((m) => m.rect.minX)),
      maxX: Math.max(...members.map((m) => m.rect.maxX)),
      minZ: Math.min(...members.map((m) => m.rect.minZ)),
      maxZ: Math.max(...members.map((m) => m.rect.maxZ)),
    };
    const cx = (box.minX + box.maxX) / 2;
    const cz = (box.minZ + box.maxZ) / 2;
    const d = { x: cx * (k - 1), z: cz * (k - 1) };
    d.x += snap(box.minX + d.x, box.maxX + d.x, hw);
    d.z += snap(box.minZ + d.z, box.maxZ + d.z, hd);
    for (const m of members) m.move(d);
  }
  return {
    ...interior,
    size,
    spawn: scale(interior.spawn),
    obstacles: interior.obstacles.map((o) => ({ ...o, ...scale(o) })),
    stations: stations.map((s) => {
      if (s.kind === 'exit')
        return { ...s, position: { x: s.position.x * k, z: hd - s.size.d / 2 } };
      return s.solid ? s : { ...s, position: scale(s.position) };
    }),
    props: props.map((p) => (p.solid ? p : { ...p, position: scale(p.position) })),
    layoutScale: 1,
  };
}
