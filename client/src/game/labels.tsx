import { useFrame, useThree } from '@react-three/fiber';
import { Vector3 } from 'three';
import { gameData } from '@narco/shared';
import type { PlayerInfo } from './Players';

/**
 * Étiquettes flottantes en DOM pur (hors canvas) : un seul calque, positionné à chaque frame
 * par projection caméra. Aucun draw call, aucune racine React par étiquette.
 */

type Anchor = () => { x: number; y: number; z: number } | null;

const anchors = new Map<string, Anchor>();
const elements = new Map<string, HTMLElement>();

export function setLabelAnchor(id: string, anchor: Anchor | null): void {
  if (anchor) anchors.set(id, anchor);
  else anchors.delete(id);
}

function bindElement(id: string) {
  return (el: HTMLElement | null) => {
    if (el) elements.set(id, el);
    else elements.delete(id);
  };
}

// Les lieux ne bougent pas : ancres posées une fois pour toutes.
for (const loc of gameData.locations.values()) {
  const y = loc.height + (loc.kind === 'area' ? 1 : 2.2);
  setLabelAnchor(`place:${loc.id}`, () => ({ x: loc.position.x, y, z: loc.position.z }));
}

const v = new Vector3();

/** À placer dans le Canvas : projette chaque ancre et déplace l'élément DOM correspondant. */
export function LabelProjector() {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  useFrame(() => {
    for (const [id, el] of elements) {
      const p = anchors.get(id)?.();
      if (!p) {
        el.style.visibility = 'hidden';
        continue;
      }
      v.set(p.x, p.y, p.z).project(camera);
      if (v.z > 1 || v.x < -1.2 || v.x > 1.2 || v.y < -1.2 || v.y > 1.2) {
        el.style.visibility = 'hidden';
        continue;
      }
      const x = ((v.x + 1) / 2) * size.width;
      const y = ((1 - v.y) / 2) * size.height;
      el.style.visibility = 'visible';
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    }
  });
  return null;
}

/** Calque DOM des étiquettes (lieux + joueurs), à placer hors du Canvas. */
export function LabelLayer({ players, myId }: { players: PlayerInfo[]; myId: string }) {
  return (
    <div className="label-layer">
      {[...gameData.locations.values()].map((loc) => (
        <div
          key={loc.id}
          ref={bindElement(`place:${loc.id}`)}
          className="place-label"
          style={{ borderColor: loc.neonColor, color: loc.neonColor }}
        >
          {loc.name}
        </div>
      ))}
      {players.map((p) => (
        <div
          key={p.id}
          ref={bindElement(`player:${p.id}`)}
          className={`player-label${p.connected ? '' : ' offline'}`}
        >
          {p.id === myId ? `${p.name} (toi)` : p.connected ? p.name : `${p.name} 💤`}
        </div>
      ))}
    </div>
  );
}
