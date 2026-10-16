import { useEffect, useRef } from 'react';
import { connection } from '../net/connection';
import { currentArea } from '../game/areaStreaming';
import { getSettings } from './settings';
import { gameData } from '@narco/shared';
import { propDrawCalls } from '../game/city/PropKits';

/** Alimenté par `DebugProbe` dans la scène ; lu ici 4 fois par seconde. */
export const debugStats = { fps: 0, calls: 0, triangles: 0 };

/**
 * Draw calls mesurés (gl.info) par thème et par area du joueur : maximum vu depuis l'ouverture.
 * Budget iPad : < 200 au total, objectif < 60 par area (⚠ au-delà).
 */
const callsByArea = new Map<string, number>();
const { drawCallTarget: AREA_TARGET, drawCallBudget: FRAME_BUDGET } = gameData.config.props;

export function DebugOverlay() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = setInterval(() => {
      const el = ref.current;
      if (!el) return;
      const room = connection.getSnapshot().room;
      const ping = room?.connection.isOpen ? 'ws ouvert' : 'ws fermé';
      const area = currentArea();
      const { theme, quality } = getSettings();
      const key = `${theme}/${area}`;
      if (area) callsByArea.set(key, Math.max(callsByArea.get(key) ?? 0, debugStats.calls));
      const perArea = [...callsByArea]
        .map(([a, n]) => `${a} ${n}${n > AREA_TARGET ? ' ⚠' : ''}`)
        .join(' · ');
      const over = debugStats.calls > FRAME_BUDGET ? ' ⚠ budget' : '';
      el.textContent =
        `${debugStats.fps.toFixed(0)} fps · ${debugStats.calls} draw calls${over} · ` +
        `${(debugStats.triangles / 1000).toFixed(1)}k tris · ${ping}\n` +
        `${theme} · ${quality} · area ${area || '—'}
max par thème/area : ${perArea || '—'}
décor 3D : ${Object.entries(propDrawCalls())
          .map(([c, n]) => `${c} ${n}`)
          .join(' · ')}`;
      el.dataset.low = debugStats.fps < 30 ? '1' : '0';
    }, 250);
    return () => clearInterval(id);
  }, []);
  return <div ref={ref} className="debug-overlay" />;
}
