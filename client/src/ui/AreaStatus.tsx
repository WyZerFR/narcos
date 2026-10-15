import { useEffect, useState } from 'react';
import { areaAt, areaBonusLabel, gameData, type Area } from '@narco/shared';
import { localPlayer } from '../game/localPlayer';

const AREAS = [...gameData.areas.values()];
const POLL_MS = 250;
/** Niveau de danger maximal (`areas.json`, dangerLevel 0 à 5). */
const MAX_DANGER = 5;

/**
 * Pastille sous la mini-carte : area courante, danger (0 à 5) et bonus de prix des PNJ.
 * N'intercepte aucun toucher (joystick, ACTION et sac restent libres).
 */
export function AreaStatus() {
  const [area, setArea] = useState<Area | null>(null);
  useEffect(() => {
    const id = setInterval(() => {
      if (!localPlayer.initialized) return;
      const next = areaAt(AREAS, localPlayer);
      setArea((prev) => (prev?.id === next?.id ? prev : next));
    }, POLL_MS);
    return () => clearInterval(id);
  }, []);
  if (!area) return null;
  const bonus = areaBonusLabel(area.priceMultiplier);
  const { palette } = gameData.config;
  return (
    <div className="area-status" style={{ borderColor: area.themeColor }}>
      <span className="area-status-name" style={{ color: area.themeColor }}>
        {area.name}
      </span>
      <span className="area-danger" aria-label={`Danger ${area.dangerLevel} sur ${MAX_DANGER}`}>
        {Array.from({ length: MAX_DANGER }, (_, i) => (
          <span
            key={i}
            className="danger-pip"
            style={{ background: i < area.dangerLevel ? palette.danger : 'transparent' }}
          />
        ))}
      </span>
      {bonus && <span className="area-bonus">{bonus}</span>}
    </div>
  );
}
