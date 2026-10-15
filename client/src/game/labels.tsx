import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { Vector3 } from 'three';
import type { GameRoom } from '../net/connection';
import { gameNow } from '../net/gameView';
import { placeView } from './stationView';
import { fixturesFor, placesOf, useFixtures } from './fixtureState';
import { useNpcList } from './npcState';
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
/** Rafraîchissement des statuts de postes (texte + barre) : 5 fois par seconde suffit. */
const STATUS_REFRESH_MS = 200;
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
  ...[...gameData.quartierLayouts.values()].flatMap((l) =>
    l.houses.map((h) => ({ rect: h.rect, height: h.height })),
  ),
];

/** Enseignes des arches d'entrée et gardes des impasses (décor, étiquettes fixes). */
const QUARTIER_SIGNS = [...gameData.quartierLayouts.values()].flatMap((l) => {
  const q = gameData.quartiers.get(l.id)!;
  const { arch } = l;
  return [
    {
      id: `arch:${l.id}`,
      text: arch.label,
      color: q.palette.neon,
      className: 'place-label quartier-sign',
      at: { x: (arch.left.x + arch.right.x) / 2, y: arch.height + 0.8, z: arch.left.z },
    },
    ...l.guards.map((g, i) => ({
      id: `guard:${l.id}:${i}`,
      text: 'Garde',
      color: q.palette.neon,
      className: 'guard-label',
      at: { x: g.x, y: 2.1, z: g.z },
    })),
  ];
});
for (const s of QUARTIER_SIGNS) setLabelAnchor(s.id, () => s.at);

/** Un bâtiment coupe-t-il la ligne de vue caméra → point ? */
export function isOccluded(from: Point3, to: Point3): boolean {
  return OCCLUDERS.some((box) => segmentHitsBox(from, to, box));
}

// Postes fixes des intérieurs : ancres fixes (coordonnées de la pièce). Les meubles posés ont
// des ancres dynamiques (voir LabelLayer).
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
  room,
  players,
  myId,
  zone,
}: {
  room: GameRoom;
  players: PlayerInfo[];
  myId: string;
  zone: string;
}) {
  const npcs = useNpcList(room);
  const fixtures = useFixtures(room, zone);
  // Étiquettes des meubles : elles suivent leur position réelle (posé, déplacé).
  useEffect(() => {
    for (const f of fixtures)
      setLabelAnchor(`station:${zone}:${f.id}`, () => ({ ...f.position, y: 2.3 }));
    return () => {
      for (const f of fixtures) setLabelAnchor(`station:${zone}:${f.id}`, null);
    };
  }, [fixtures, zone]);
  const statusRefs = useRef(
    new Map<
      string,
      {
        root: HTMLElement;
        name: HTMLElement;
        status: HTMLElement;
        fill: HTMLElement;
        bar: HTMLElement;
      }
    >(),
  );

  // État des postes (statut + barre), visible par tous : mis à jour en DOM, sans re-rendu React.
  useEffect(() => {
    const interior = gameData.interiors.get(zone);
    if (!interior) return;
    const update = () => {
      const now = gameNow();
      for (const place of placesOf(zone, fixturesFor(room, zone))) {
        const els = statusRefs.current.get(place.id);
        if (!els) continue;
        const view = placeView(room, place, myId, now, zone);
        // une lampe posée n'a rien à dire
        if (place.fixture?.accepts === 'lamp') {
          els.root.style.display = 'none';
          continue;
        }
        els.status.textContent = view.status ?? '';
        els.bar.style.display = view.progress === undefined ? 'none' : '';
        els.fill.style.width = `${Math.round((view.progress ?? 0) * 100)}%`;
        els.fill.dataset.done = view.progress === 1 ? '1' : '0';
      }
    };
    update();
    const id = setInterval(update, STATUS_REFRESH_MS);
    return () => clearInterval(id);
  }, [room, zone, myId]);

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
      {zone === STREET &&
        QUARTIER_SIGNS.map((s) => (
          <div
            key={s.id}
            ref={bindElement(s.id)}
            className={s.className}
            style={{ borderColor: s.color, color: s.color }}
          >
            {s.text}
          </div>
        ))}
      {[...(gameData.interiors.get(zone)?.stations ?? []), ...fixtures].map((st) => (
        <div key={st.id} ref={bindElement(`station:${zone}:${st.id}`)} className="station-label">
          <span className="station-name">{st.label}</span>
          <span
            className="station-status"
            ref={(el) => {
              const bar = el?.nextElementSibling as HTMLElement | null;
              const fill = bar?.firstElementChild as HTMLElement | null;
              const name = el?.previousElementSibling as HTMLElement | null;
              const root = el?.parentElement ?? null;
              if (el && bar && fill && name && root)
                statusRefs.current.set(st.id, { root, name, status: el, bar, fill });
              else statusRefs.current.delete(st.id);
            }}
          />
          <span className="station-bar">
            <i />
          </span>
        </div>
      ))}
      {zone === STREET &&
        npcs
          .filter((n) => n.interested)
          .map((n) => (
            <div
              key={`npc:${n.id}`}
              ref={bindElement(`npc:${n.id}`)}
              className={`npc-label${n.busyWith && n.busyWith !== myId ? ' busy' : ''}`}
            >
              {n.busyWith && n.busyWith !== myId ? '⏳' : '💬'} {n.name}
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
