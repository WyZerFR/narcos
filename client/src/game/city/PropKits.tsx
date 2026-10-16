import { Component, useLayoutEffect, useMemo, useRef, type ErrorInfo, type ReactNode } from 'react';
import {
  Euler,
  Matrix4,
  Quaternion,
  Vector3,
  type InstancedMesh,
  type Material,
  type Texture,
} from 'three';
import { gameData, type GameData, type PropCategory } from '@narco/shared';
import { areaIdNear } from '../areaStreaming';
import { fallbackGeometry, tintedGeometry, usePropEntry } from './propAssets';

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
  const out: Record<PropCategory, number> = { batiments: 0, vehicules: 0, props: 0, vegetation: 0 };
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
   * bâtiments. Partagé par clé (le fournisseur garde le cache).
   */
  materialFor: (texture: Texture | null, cut: boolean) => Material;
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
  const visible = useMemo(
    () => (loaded ? items.filter((_, i) => loaded.has(areas[i]!)) : []),
    [items, areas, loaded],
  );
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
    mesh.computeBoundingSphere();
  }, [visible, geometry]);
  useLayoutEffect(() => {
    if (geometry && visible.length > 0 && prop) active.set(id, prop.category);
    else active.delete(id);
    return () => void active.delete(id);
  }, [id, geometry, visible, prop]);
  const texture = status !== 'error' && entry?.status === 'ready' ? entry.texture : null;
  const material = materialFor(texture, Boolean(prop?.cuttable));
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

/** Tous les props instanciés : `items` par id de prop. */
export function PropKits({
  kits,
  ...rest
}: Omit<KitProps, 'id' | 'items' | 'failed'> & { kits: ReadonlyMap<string, PropItem[]> }) {
  return (
    <>
      {[...kits].map(([id, items]) => (
        <KitBoundary key={id} id={id} items={items} {...rest} />
      ))}
    </>
  );
}
