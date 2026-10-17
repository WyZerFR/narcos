import { areaContainsRect } from './areas';
import { findSlits } from './collision';
import type { GameData } from './data';
import { expandRect, rectFromCenter, rectsOverlap, type Rect, type Vec2 } from './geometry';
import { interactionPoint } from './locations';
import type { QuartierLayout } from './quartiers';
import {
  PROP_KIT_IDS,
  type Area,
  type Block,
  type DoorSide,
  type GameConfig,
  type GameLocation,
  type PlacementsFile,
  type Prop,
  type PropCategory,
  type PropKitId,
  type PropPlacement,
} from './schemas';

/** Emprise au sol d'un prop posé (null : traversable). Un cercle devient son carré circonscrit. */
export function placementFootprint(prop: Prop, p: PropPlacement): Rect | null {
  const c = prop.collision;
  if (!c) return null;
  if (c.shape === 'circle')
    return rectFromCenter(p, { w: 2 * c.r * p.scale, d: 2 * c.r * p.scale });
  const turned = p.rotation === 90 || p.rotation === 270;
  const w = c.w * p.scale;
  const d = c.d * p.scale;
  return rectFromCenter(p, turned ? { w: d, d: w } : { w, d });
}

/** Tous les props posés, avec leur area. */
export function allPlacements(placements: PlacementsFile): (PropPlacement & { areaId: string })[] {
  return Object.entries(placements.areas).flatMap(([areaId, list]) =>
    list.map((p) => ({ ...p, areaId })),
  );
}

/** Obstacles des props posés (boîtes simples de props.json, jamais le maillage). */
export function placementObstacles(data: Pick<GameData, 'props' | 'placements'>): Rect[] {
  return allPlacements(data.placements).flatMap((p) => {
    const prop = data.props.get(p.prop);
    const r = prop ? placementFootprint(prop, p) : null;
    return r ? [r] : [];
  });
}

/** Catégorie de prop attendue par chaque décor généré remplaçable. */
const KIT_CATEGORY: Record<PropKitId, PropCategory> = {
  trees: 'vegetation',
  palms: 'vegetation',
  cars: 'vehicules',
  policeCars: 'vehicules',
  houses: 'batiments',
  towers: 'batiments',
  fillers: 'batiments',
  bushes: 'vegetation',
};

/** Le décor généré `kit` est-il remplacé par des modèles ? */
export function kitModelled(data: Pick<GameData, 'placements'>, kit: PropKitId): boolean {
  return data.placements.kits[kit].props.length > 0;
}

/** Rotation (degrés) qui tourne l'avant d'un modèle (+Z) vers la porte. */
const FACADE_ROTATION: Record<DoorSide, 0 | 90 | 180 | 270> = {
  south: 0,
  east: 90,
  north: 180,
  west: 270,
};

/** Façade importée d'un lieu ou d'un bloc : prop, centre, rotation vers la porte. */
export interface FacadePlacement {
  locationId: string;
  prop: string;
  x: number;
  z: number;
  rotation: 0 | 90 | 180 | 270;
}

/** Ce qu'une façade importée recouvre : lieu bâtiment visible ou bloc décoratif, à porte. */
type FacadeHost = Pick<GameLocation, 'position' | 'size'> & { door: DoorSide };

function facadeHost(
  locations: ReadonlyMap<string, GameLocation>,
  blocks: readonly Block[],
  id: string,
): FacadeHost | null {
  const loc = locations.get(id);
  if (loc)
    return loc.kind === 'building' && loc.door && !loc.hidden ? { ...loc, door: loc.door } : null;
  const block = blocks.find((b) => b.id === id);
  return block?.door ? { ...block, door: block.door } : null;
}

/**
 * Façades importées (`placements.facades`) des lieux visibles à porte et des blocs décoratifs
 * à porte (commissariat : sans interaction).
 */
export function facadePlacements(
  data: Pick<GameData, 'placements' | 'locations' | 'blocks'>,
): FacadePlacement[] {
  return Object.entries(data.placements.facades).flatMap(([locationId, prop]) => {
    const host = facadeHost(data.locations, data.blocks, locationId);
    if (!host) return [];
    const { x, z } = host.position;
    return [{ locationId, prop, x, z, rotation: FACADE_ROTATION[host.door] }];
  });
}

/** Le lieu a-t-il une façade importée (silhouette et panneau générés sautés) ? */
export function hasFacade(data: Pick<GameData, 'placements'>, locationId: string): boolean {
  return locationId in data.placements.facades;
}

/**
 * Cohérence des façades : lieu bâtiment visible à porte, prop de famille `facade` dont
 * l'emprise et la collision, tournées vers la porte, tiennent dans la taille du lieu.
 */
export function checkFacades(
  props: ReadonlyMap<string, Prop>,
  placements: PlacementsFile,
  locations: ReadonlyMap<string, GameLocation>,
  blocks: readonly Block[],
): string[] {
  const errors: string[] = [];
  for (const [locId, id] of Object.entries(placements.facades)) {
    const where = `placements.json : facades.${locId}`;
    const loc = facadeHost(locations, blocks, locId);
    const prop = props.get(id);
    if (!loc) {
      errors.push(`${where} : lieu inconnu, caché ou sans porte`);
      continue;
    }
    if (!prop || prop.family !== 'facade' || !prop.footprint) {
      errors.push(`${where} : "${id}" n'est pas un prop de famille facade`);
      continue;
    }
    const turned = loc.door === 'east' || loc.door === 'west';
    const w = turned ? loc.size.d : loc.size.w;
    const d = turned ? loc.size.w : loc.size.d;
    const c = prop.collision;
    if (
      prop.footprint.w > w ||
      prop.footprint.d > d ||
      (c?.shape === 'rect' && (c.w > w || c.d > d))
    )
      errors.push(
        `${where} : "${id}" déborde de la taille du lieu (${loc.size.w} × ${loc.size.d})`,
      );
  }
  return errors;
}

function distanceToRect(p: Vec2, r: Rect): number {
  const dx = Math.max(r.minX - p.x, 0, p.x - r.maxX);
  const dz = Math.max(r.minZ - p.z, 0, p.z - r.maxZ);
  return Math.hypot(dx, dz);
}

/**
 * Cohérence des placements : props connus et de la bonne catégorie, chaque prop posé dans son
 * area, hors des routes, trottoirs et placettes des impasses, à `doorClearance` des portes,
 * sans chevaucher un obstacle ni créer de fente plus étroite qu'un diamètre + marge.
 * `obstacles` : obstacles de la rue sans les props posés.
 */
export function checkPlacements(
  config: GameConfig,
  props: ReadonlyMap<string, Prop>,
  placements: PlacementsFile,
  areas: ReadonlyMap<string, Area>,
  locations: Iterable<GameLocation>,
  layouts: Iterable<QuartierLayout>,
  obstacles: readonly Rect[],
): string[] {
  const errors: string[] = [];
  for (const kit of PROP_KIT_IDS)
    for (const id of placements.kits[kit].props) {
      const prop = props.get(id);
      if (!prop) errors.push(`placements.json : kits.${kit}, prop inconnu "${id}"`);
      else if (prop.category !== KIT_CATEGORY[kit])
        errors.push(
          `placements.json : kits.${kit}, "${id}" n'est pas de la catégorie ${KIT_CATEGORY[kit]}`,
        );
    }
  const layoutList = [...layouts];
  const roads = [
    ...config.map.roads.map((r) => rectFromCenter(r, r)),
    ...layoutList.flatMap((l) => [...l.roads, ...l.sidewalks, ...l.parking, l.plaza]),
  ];
  const doors = [
    ...[...locations].map(interactionPoint),
    ...layoutList.flatMap((l) => l.houses.map((h) => h.doorStep)),
  ];
  const { doorClearance } = config.props;
  const minGap = 2 * config.world.playerRadius + config.collision.passageMargin;
  const placed: Rect[] = [];
  for (const p of allPlacements(placements)) {
    const where = `placements.json : ${p.areaId}, "${p.prop}" en ${p.x}, ${p.z}`;
    const prop = props.get(p.prop);
    const area = areas.get(p.areaId);
    if (!prop || !area) {
      errors.push(`${where} : ${prop ? 'area' : 'prop'} inconnu(e)`);
      continue;
    }
    const r = placementFootprint(prop, p) ?? rectFromCenter(p, { w: 0.2, d: 0.2 });
    if (!areaContainsRect(area, r)) errors.push(`${where} : hors de son area`);
    if (roads.some((road) => rectsOverlap(road, r))) errors.push(`${where} : sur une route`);
    if (doors.some((d) => distanceToRect(d, r) < doorClearance))
      errors.push(`${where} : trop près d'une porte`);
    if (!placementFootprint(prop, p)) continue;
    if ([...obstacles, ...placed].some((o) => rectsOverlap(expandRect(o, -1e-6), r)))
      errors.push(`${where} : chevauche un obstacle`);
    placed.push(r);
  }
  const own = new Set(placed);
  for (const [a, b] of findSlits([...obstacles, ...placed], minGap))
    if (own.has(a) || own.has(b))
      errors.push(
        `placements.json : fente de moins de ${minGap} m près de (${a.minX.toFixed(1)}, ${a.minZ.toFixed(1)})`,
      );
  return errors;
}
