import { useMemo, useSyncExternalStore } from 'react';
import { BufferGeometry, Color, Float32BufferAttribute } from 'three';
import { gameData } from '@narco/shared';

/** Debug : frontières des areas affichées au sol (1 draw call, seulement si activé). */
let visible = false;
const listeners = new Set<() => void>();

export function setAreaBoundsVisible(next: boolean): void {
  visible = next;
  for (const fn of listeners) fn();
}

export function useAreaBoundsVisible(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => visible,
  );
}

const Y = 0.25;

export function AreaBounds() {
  const shown = useAreaBoundsVisible();
  const geometry = useMemo(() => {
    const pos: number[] = [];
    const col: number[] = [];
    for (const area of gameData.areas.values()) {
      const c = new Color(area.themeColor);
      const corners = area.polygon;
      corners.forEach(({ x, z }, i) => {
        const next = corners[(i + 1) % corners.length]!;
        pos.push(x, Y, z, next.x, Y, next.z);
        col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      });
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new Float32BufferAttribute(col, 3));
    return g;
  }, []);
  if (!shown) return null;
  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial vertexColors toneMapped={false} />
    </lineSegments>
  );
}
