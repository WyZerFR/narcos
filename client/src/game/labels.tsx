import { useFrame, useThree } from '@react-three/fiber';
import { Vector3 } from 'three';
import { footprint, gameData, segmentHitsBox, STREET, type Box } from '@narco/shared';
import type { PlayerInfo } from './Players';

/**
 * Étiquettes flottantes en DOM pur (hors canvas) : un seul calque, positionné à chaque frame
 * par projection caméra. Aucun draw call, aucune racine React par étiquette.
 */

type Point3 = { x: number; y: number; z: number };
/** Renvoie la position monde à suivre, ou null pour masquer l'élément. Reçoit la caméra. */
type Anchor = (camera: Point3) => Point3 | null;

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

// ---------------------------------------------------------------- occlusion

/** Volumes opaques : bâtiments et immeubles (emprise + hauteur). Le décor bas ne cache personne. */
const OCCLUDERS: Box[] = [
  ...[...gameData.locations.values()]
    .filter((l) => l.kind === 'building')
    .map((l) => ({ rect: footprint(l), height: l.height })),
  ...gameData.blocks.map((b) => ({ rect: footprint(b), height: b.height })),
];

/** Un bâtiment coupe-t-il la ligne de vue caméra → point ? */
export function isOccluded(from: Point3, to: Point3): boolean {
  return OCCLUDERS.some((box) => segmentHitsBox(from, to, box));
}

// Postes des intérieurs : ancres fixes (coordonnées de la pièce).
for (const interior of gameData.interiors.values()) {
  for (const st of interior.stations) {
    const y = st.kind === 'exit' ? 2.9 : 2.3;
    setLabelAnchor(`station:${interior.id}:${st.id}`, () => ({
      x: st.position.x,
      y,
      z: st.position.z,
    }));
  }
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
      const p = anchors.get(id)?.(camera.position);
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
      const pin = el.dataset.pin === 'center' ? '-50%, -50%' : '-50%, -100%';
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(${pin})`;
    }
  });
  return null;
}

/**
 * Calque DOM des étiquettes (lieux + joueurs) et des marqueurs de joueurs cachés derrière un
 * bâtiment, à placer hors du Canvas.
 */
export function LabelLayer({
  players,
  myId,
  zone,
}: {
  players: PlayerInfo[];
  myId: string;
  zone: string;
}) {
  return (
    <div className="label-layer">
      {zone === STREET &&
        [...gameData.locations.values()].map((loc) => (
          <div
            key={loc.id}
            ref={bindElement(`place:${loc.id}`)}
            className="place-label"
            style={{ borderColor: loc.neonColor, color: loc.neonColor }}
          >
            {loc.name}
          </div>
        ))}
      {gameData.interiors.get(zone)?.stations.map((st) => (
        <div key={st.id} ref={bindElement(`station:${zone}:${st.id}`)} className="station-label">
          {st.label}
        </div>
      ))}
      {players.map((p) => (
        <div
          key={`marker:${p.id}`}
          ref={bindElement(`marker:${p.id}`)}
          data-pin="center"
          className="occluded-marker"
          style={{ borderColor: p.color, color: p.color }}
        >
          <span style={{ background: p.color }} />
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
