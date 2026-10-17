import {
  Component,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import {
  BufferAttribute,
  Euler,
  Matrix4,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type InstancedMesh,
  type Material,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { gameData, type GameData, type PropCategory } from '@narco/shared';
import { areaIdNear } from '../areaStreaming';
import {
  fallbackGeometry,
  propEntry,
  requestProp,
  tintedGeometry,
  usePropCacheVersion,
  usePropEntry,
} from './propAssets';
import { shade } from './batch';

/** Une instance de prop : position au sol, rotation Y, échelle par axe (repère du prop). */
export interface PropItem {
  x: number;
  z: number;
  y?: number;
  rotY?: number;
  sx?: number;
  sy?: number;
  sz?: number;
}

/** Draw calls du décor importé par catégorie (overlay debug) : un InstancedMesh visible = 1. */
const active = new Map<string, PropCategory>();

export function propDrawCalls(): Record<PropCategory, number> {
  const out: Record<PropCategory, number> = {
    batiments: 0,
    vehicules: 0,
    avions: 0,
    props: 0,
    vegetation: 0,
  };
  for (const c of active.values()) out[c]++;
  return out;
}

const tmpM = new Matrix4();
const tmpQ = new Quaternion();
const tmpE = new Euler();
const tmpP = new Vector3();
const tmpS = new Vector3();

interface KitProps {
  id: string;
  items: PropItem[];
  /** Areas chargées (null : préchauffage, rien n'est demandé). */
  loaded: ReadonlySet<string> | null;
  data: GameData;
  /**
   * Matériau d'un prop : atlas de son pack (null : couleurs de sommets), découpe pour les
   * bâtiments, néons (`emit` : géométrie avec `aEmit`). Partagé par clé (le fournisseur garde
   * le cache).
   */
  materialFor: (texture: Texture | null, cut: boolean, emit: boolean, paint?: boolean) => Material;
  /** Gain de couleur par catégorie (props.json tint), demandé par le thème (jour). */
  propTint?: boolean;
  /** Repli forcé (error boundary). */
  failed?: boolean;
}

/**
 * Un InstancedMesh par prop (1 draw call), seules les instances des areas chargées sont écrites.
 * Le modèle n'est demandé qu'une fois une de ses areas chargée ; rien n'est dessiné pendant le
 * chargement, le cube neutre si le modèle échoue.
 */
function Kit({ id, items, loaded, data, materialFor, failed, propTint = false }: KitProps) {
  const ref = useRef<InstancedMesh>(null);
  const prop = gameData.props.get(id);
  const areas = useMemo(() => items.map((it) => areaIdNear(it)), [items]);
  // index des instances visibles dans `items` (teinte de carrosserie stable par instance)
  const shown = useMemo(
    () => (loaded ? items.flatMap((_, i) => (loaded.has(areas[i]!) ? [i] : [])) : []),
    [items, areas, loaded],
  );
  const visible = useMemo(() => shown.map((i) => items[i]!), [shown, items]);
  const entry = usePropEntry(id, visible.length > 0);
  const status = failed || !prop ? 'error' : entry?.status;
  const geometry = useMemo(() => {
    if (status === 'error') return fallbackGeometry(prop, data.config);
    if (entry?.status === 'ready' && prop)
      return tintedGeometry(
        entry.geometry,
        prop,
        data.config,
        propTint ? data.propsTint[prop.category] : null,
      );
    return null;
  }, [status, entry, prop, data, propTint]);
  // la géométrie du cache est partagée : seules les copies (repli, teinte) sont libérées ici
  useLayoutEffect(
    () => () => {
      if (geometry && !(entry?.status === 'ready' && entry.geometry === geometry))
        geometry.dispose();
    },
    [geometry, entry],
  );
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    mesh.count = visible.length;
    visible.forEach((it, i) => {
      tmpQ.setFromEuler(tmpE.set(0, it.rotY ?? 0, 0));
      tmpS.set(it.sx ?? 1, it.sy ?? it.sx ?? 1, it.sz ?? it.sx ?? 1);
      mesh.setMatrixAt(i, tmpM.compose(tmpP.set(it.x, it.y ?? 0, it.z), tmpQ, tmpS));
    });
    mesh.instanceMatrix.needsUpdate = true;
    // carrosserie : une teinte de `config.props.paints` par instance, en alternance
    if (geometry?.attributes.aPaint) {
      const { paints } = data.config.props;
      shown.forEach((index, i) => {
        const p = paints[index % paints.length]!;
        mesh.setColorAt(i, shade(data.config.palette[p.color], p.shade));
      });
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    mesh.computeBoundingSphere();
  }, [visible, shown, geometry, data]);
  useLayoutEffect(() => {
    if (geometry && visible.length > 0 && prop) active.set(id, prop.category);
    else active.delete(id);
    return () => void active.delete(id);
  }, [id, geometry, visible, prop]);
  const texture = status !== 'error' && entry?.status === 'ready' ? entry.texture : null;
  const material = materialFor(
    texture,
    Boolean(prop?.cuttable),
    Boolean(geometry?.attributes.aEmit),
    Boolean(geometry?.attributes.aPaint),
  );
  if (!geometry || items.length === 0) return null;
  return (
    <instancedMesh
      ref={ref}
      name={id}
      args={[geometry, material, items.length]}
      frustumCulled={false}
    />
  );
}

/** Une erreur de rendu d'un prop : journalisée, le prop passe au cube neutre. */
class KitBoundary extends Component<KitProps, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn(`[narco] prop "${this.props.id}" en erreur, repli sur le cube`, error, info);
  }
  override render(): ReactNode {
    return <Kit {...this.props} failed={this.state.failed} />;
  }
}

/** Matrice monde d'une instance (repère du prop → monde). */
function itemMatrix(it: PropItem): Matrix4 {
  tmpQ.setFromEuler(tmpE.set(0, it.rotY ?? 0, 0));
  tmpS.set(it.sx ?? 1, it.sy ?? it.sx ?? 1, it.sz ?? it.sx ?? 1);
  return new Matrix4().compose(tmpP.set(it.x, it.y ?? 0, it.z), tmpQ, tmpS);
}

/** Fusion des instances (géométrie du prop placée en monde) en une seule géométrie. */
export function mergeInstances(
  parts: readonly { geometry: BufferGeometry; item: PropItem }[],
): BufferGeometry | null {
  if (parts.length === 0) return null;
  const placed = parts.map(({ geometry, item }) => geometry.clone().applyMatrix4(itemMatrix(item)));
  const merged = mergeGeometries(placed);
  for (const g of placed) g.dispose();
  merged?.computeBoundingSphere();
  return merged;
}

/** Néons absents (repli, modèle sans néon) : `aEmit` à 0 pour fusionner avec les autres. */
function withEmit(g: BufferGeometry): BufferGeometry {
  if (g.attributes.aEmit) return g;
  const out = g.clone();
  out.setAttribute(
    'aEmit',
    new BufferAttribute(new Float32Array(out.attributes.position!.count), 1),
  );
  return out;
}

interface MergedGroup extends Omit<KitProps, 'id' | 'items' | 'failed'> {
  kits: ReadonlyMap<string, PropItem[]>;
  /** Nom du Mesh et catégorie comptée par l'overlay debug. */
  name: string;
  category: PropCategory;
  /** Découpe et néons (façades) : même matériau pour tout le groupe. */
  cut?: boolean;
  emit?: boolean;
}

/**
 * Props posés fusionnés (`mergedPropIds`) ou façades (`mergedFacadeIds`) : un seul Mesh (1 draw
 * call) pour les instances des areas chargées, reconstruit quand les areas ou les modèles
 * changent ; cube neutre en repli.
 */
function MergedProps({
  kits,
  loaded,
  data,
  materialFor,
  propTint = false,
  name,
  category,
  cut = false,
  emit = false,
}: MergedGroup) {
  const visible = useMemo(
    () =>
      loaded
        ? [...kits].flatMap(([id, items]) =>
            items.filter((it) => loaded.has(areaIdNear(it))).map((item) => ({ id, item })),
          )
        : [],
    [kits, loaded],
  );
  const wanted = useMemo(() => [...new Set(visible.map((v) => v.id))], [visible]);
  useEffect(() => {
    for (const id of wanted) requestProp(id);
  }, [wanted]);
  const version = usePropCacheVersion();
  const geometry = useMemo(() => {
    // attend que tous les modèles voulus soient prêts (ou en échec) : une seule construction
    if (wanted.some((id) => (propEntry(id)?.status ?? 'loading') === 'loading')) return null;
    const ofId = new Map<string, BufferGeometry>();
    for (const id of wanted) {
      const prop = gameData.props.get(id);
      const entry = propEntry(id);
      const base =
        entry?.status === 'ready' && prop
          ? tintedGeometry(
              entry.geometry,
              prop,
              data.config,
              propTint ? data.propsTint[prop.category] : null,
            )
          : fallbackGeometry(prop, data.config);
      const g = emit ? withEmit(base) : base;
      if (g !== base && !(entry?.status === 'ready' && entry.geometry === base)) base.dispose();
      ofId.set(id, g);
    }
    const merged = mergeInstances(
      visible.map((v) => ({ geometry: ofId.get(v.id)!, item: v.item })),
    );
    // copies seules (teinte, repli) : la géométrie du cache reste partagée
    for (const [id, g] of ofId) {
      const entry = propEntry(id);
      if (!(entry?.status === 'ready' && entry.geometry === g)) g.dispose();
    }
    return merged;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version : cache des modèles muté
  }, [visible, wanted, version, data, propTint]);
  useLayoutEffect(() => () => geometry?.dispose(), [geometry]);
  useLayoutEffect(() => {
    if (geometry) active.set(name, category);
    else active.delete(name);
    return () => void active.delete(name);
  }, [geometry, name, category]);
  if (!geometry) return null;
  return <mesh name={name} geometry={geometry} material={materialFor(null, cut, emit)} />;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * Tous les props : un InstancedMesh par id (`items` par id), sauf les props posés fusionnés
 * (`merged`) et les façades fusionnées (`facades`), dessinés chacun en un seul Mesh.
 */
export function PropKits({
  kits,
  merged = NONE,
  facades = NONE,
  ...rest
}: Omit<KitProps, 'id' | 'items' | 'failed'> & {
  kits: ReadonlyMap<string, PropItem[]>;
  merged?: ReadonlySet<string>;
  facades?: ReadonlySet<string>;
}) {
  const split = useMemo(() => {
    const own = new Map<string, PropItem[]>();
    const fused = new Map<string, PropItem[]>();
    const fronts = new Map<string, PropItem[]>();
    for (const [id, items] of kits)
      (merged.has(id) ? fused : facades.has(id) ? fronts : own).set(id, items);
    const lit = (ids: Iterable<string>) => [...ids].some((id) => gameData.props.get(id)?.emissive);
    return { own, fused, fronts, emit: lit(fronts.keys()), fusedEmit: lit(fused.keys()) };
  }, [kits, merged, facades]);
  return (
    <>
      {[...split.own].map(([id, items]) => (
        <KitBoundary key={id} id={id} items={items} {...rest} />
      ))}
      {split.fused.size > 0 && (
        <MergedProps
          kits={split.fused}
          name="props_fusionnes"
          category="props"
          emit={split.fusedEmit}
          {...rest}
        />
      )}
      {split.fronts.size > 0 && (
        <MergedProps
          kits={split.fronts}
          name="facades_fusionnees"
          category="batiments"
          cut
          emit={split.emit}
          {...rest}
        />
      )}
    </>
  );
}
