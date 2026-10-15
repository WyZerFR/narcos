import { useEffect, useState } from 'react';
import { areaAt, gameData, type Area } from '@narco/shared';
import { localPlayer } from '../game/localPlayer';

const AREAS = [...gameData.areas.values()];
const POLL_MS = 250;

/**
 * Message court en haut de l'écran à chaque changement d'area (« Quartier Nord — Territoire
 * d'El Jefe »…), depuis la position prédite du joueur local. N'intercepte aucun toucher.
 */
export function AreaBanner() {
  const [shown, setShown] = useState<Area | null>(null);

  useEffect(() => {
    let current: string | null = null;
    let hideAt = 0;
    const id = setInterval(() => {
      if (!localPlayer.initialized) return;
      const area = areaAt(AREAS, localPlayer);
      if (area && area.id !== current) {
        current = area.id;
        hideAt = Date.now() + gameData.config.ui.areaBannerMs;
        setShown(area);
      } else if (hideAt && Date.now() >= hideAt) {
        hideAt = 0;
        setShown(null);
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, []);

  if (!shown) return null;
  return (
    <div
      className="area-banner"
      role="status"
      style={{ color: shown.themeColor, borderColor: shown.themeColor }}
    >
      {shown.banner}
    </div>
  );
}
