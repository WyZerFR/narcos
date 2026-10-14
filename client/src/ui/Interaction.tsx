import { useEffect, useRef, useState } from 'react';
import {
  ClientMsg,
  gameData,
  nearestLocation,
  nearestPlace,
  STREET,
  type FixtureMessage,
  type InteractMessage,
  type SaleOpenMessage,
  type Place,
  type StationMessage,
} from '@narco/shared';
import { connection, type GameRoom } from '../net/connection';
import { localPlayer } from '../game/localPlayer';
import { ActionButton } from '../input/ActionButton';
import { onAction } from '../input/inputState';
import { gameNow } from '../net/gameView';
import { placeView } from '../game/stationView';
import { installedSet, placesOf } from '../game/fixtureState';
import { npcSmoothed } from '../game/npcState';

const LOCATIONS = [...gameData.locations.values()];
/** Fréquence de recherche de la cible proche (pas besoin de 60 Hz pour un libellé). */
const PROBE_MS = 160;
const TOAST_MS = 3500;

interface Toast {
  key: number;
  ok: boolean;
  text: string;
}

/** Ce que ferait le bouton ACTION maintenant. */
interface Target {
  /** Identifiant stable : le libellé n'est recalculé que s'il change. */
  key: string;
  label: string;
  active: boolean;
  message:
    | { type: typeof ClientMsg.Interact; body: InteractMessage }
    | { type: typeof ClientMsg.Station; body: StationMessage }
    | { type: typeof ClientMsg.Fixture; body: FixtureMessage }
    | { type: typeof ClientMsg.SaleOpen; body: SaleOpenMessage }
    | null;
  /** Emplacement installé au repos : bouton secondaire « Démonter ». */
  uninstall?: string;
}

/** Action proposée sur un poste ou un emplacement, selon son état et le sac du joueur. */
function placeTarget(room: GameRoom, place: Place): Target {
  const view = placeView(room, place, connection.playerId, gameNow(), localPlayer.zone);
  const action = view.install ? 'install' : view.action;
  const message: Target['message'] = view.install
    ? { type: ClientMsg.Fixture, body: { fixtureId: place.id, action: 'install' } }
    : view.action
      ? { type: ClientMsg.Station, body: { stationId: place.id, action: view.action } }
      : null;
  return {
    key: `${place.id}:${action ?? ''}:${view.uninstall ? 'u' : ''}`,
    label: view.label,
    active: view.active && Boolean(message),
    message,
    ...(view.uninstall ? { uninstall: place.id } : {}),
  };
}

/** PNJ acheteur le plus proche à portée de vente (positions lissées, comme à l'écran). */
function npcTarget(room: GameRoom): Target | null {
  const { saleRadius } = gameData.config.npc;
  let best: Target | null = null;
  let bestD = saleRadius;
  room.state.npcs?.forEach((n) => {
    if (!n.interested) return;
    const pos = npcSmoothed.get(n.id) ?? n;
    const d = Math.hypot(pos.x - localPlayer.x, pos.z - localPlayer.z);
    if (d > bestD) return;
    bestD = d;
    const busy = Boolean(n.busyWith) && n.busyWith !== connection.playerId;
    best = {
      key: `npc:${n.id}:${busy ? 'busy' : ''}`,
      label: busy ? `${n.name} est occupé` : `Vendre à ${n.name}`,
      active: !busy,
      message: busy ? null : { type: ClientMsg.SaleOpen, body: { npcId: n.id } },
    };
  });
  return best;
}

function findTarget(room: GameRoom): Target | null {
  if (!localPlayer.initialized) return null;
  if (localPlayer.zone === STREET) {
    // un acheteur à portée passe avant la porte d'un lieu
    const buyer = npcTarget(room);
    if (buyer) return buyer;
    const loc = nearestLocation(localPlayer, LOCATIONS);
    return loc
      ? {
          key: `loc:${loc.id}`,
          label: `Entrer : ${loc.name}`,
          active: true,
          message: { type: ClientMsg.Interact, body: { locationId: loc.id } },
        }
      : null;
  }
  const place = nearestPlace(localPlayer, placesOf(localPlayer.zone, installedSet(room)));
  return place ? placeTarget(room, place) : null;
}

/** Bouton ACTION contextuel (porte d'un lieu, poste d'intérieur) + toast de la réponse serveur. */
export function Interaction({ room }: { room: GameRoom }) {
  const [target, setTarget] = useState<Target | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const targetRef = useRef<Target | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      const next = findTarget(room);
      const prev = targetRef.current;
      if (
        next?.key !== prev?.key ||
        next?.label !== prev?.label ||
        next?.active !== prev?.active ||
        next?.uninstall !== prev?.uninstall
      ) {
        targetRef.current = next;
        setTarget(next);
      }
    }, PROBE_MS);
    return () => clearInterval(id);
  }, [room]);

  // L'intention part au serveur, qui vérifie tout et répond par une notice.
  useEffect(
    () =>
      onAction(() => {
        const msg = targetRef.current?.message;
        if (!msg || !targetRef.current?.active || !room.connection.isOpen) return;
        room.send(msg.type, msg.body);
      }),
    [room],
  );

  useEffect(
    () =>
      connection.onNotice((n) => {
        setToast({ key: Date.now(), ok: n.ok, text: n.text });
      }),
    [],
  );

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <>
      <ActionButton label={target?.label ?? 'ACTION'} active={Boolean(target?.active)} />
      {target?.uninstall && (
        <button
          type="button"
          className="secondary-action"
          onClick={() => {
            const fixtureId = target.uninstall;
            if (fixtureId && room.connection.isOpen)
              room.send(ClientMsg.Fixture, { fixtureId, action: 'uninstall' });
          }}
        >
          Démonter
        </button>
      )}
      {toast && (
        <div key={toast.key} className={`toast${toast.ok ? '' : ' bad'}`}>
          {toast.text}
        </div>
      )}
    </>
  );
}
