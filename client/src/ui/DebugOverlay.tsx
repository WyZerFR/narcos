import { useEffect, useRef } from 'react';
import { connection } from '../net/connection';
import { currentArea } from '../game/areaStreaming';

/** Alimenté par `DebugProbe` dans la scène ; lu ici 4 fois par seconde. */
export const debugStats = { fps: 0, calls: 0, triangles: 0 };

/** Draw calls mesurés (gl.info) par area du joueur : maximum vu depuis l'ouverture. */
const callsByArea = new Map<string, number>();

export function DebugOverlay() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = setInterval(() => {
      const el = ref.current;
      if (!el) return;
      const room = connection.getSnapshot().room;
      const ping = room?.connection.isOpen ? 'ws ouvert' : 'ws fermé';
      const area = currentArea();
      if (area) callsByArea.set(area, Math.max(callsByArea.get(area) ?? 0, debugStats.calls));
      const perArea = [...callsByArea].map(([a, n]) => `${a} ${n}`).join(' · ');
      el.textContent =
        `${debugStats.fps.toFixed(0)} fps · ${debugStats.calls} draw calls · ` +
        `${(debugStats.triangles / 1000).toFixed(1)}k tris · ${ping}\n` +
        `area ${area || '—'} · max par area : ${perArea || '—'}`;
      el.dataset.low = debugStats.fps < 30 ? '1' : '0';
    }, 250);
    return () => clearInterval(id);
  }, []);
  return <div ref={ref} className="debug-overlay" />;
}
