import { useEffect, useRef, useState } from 'react';
import {
  ClientMsg,
  gameData,
  nearestLocation,
  nearestStation,
  STREET,
  type InteractMessage,
  type Station,
  type StationAction,
  type StationMessage,
} from '@narco/shared';
import { connection, type GameRoom } from '../net/connection';
import { localPlayer } from '../game/localPlayer';
import { ActionButton } from '../input/ActionButton';
import { onAction } from '../input/inputState';

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
    | null;
}

/** Action proposée sur un poste (complétée par l'état de production au bloc suivant). */
function stationTarget(station: Station): Target {
  const act = (action: StationAction, label: string): Target => ({
    key: `${station.id}:${action}`,
    label,
    active: true,
    message: { type: ClientMsg.Station, body: { stationId: station.id, action } },
  });
  if (station.kind === 'exit') return act('exit', 'Sortir');
  return { key: station.id, label: station.label, active: false, message: null };
}

function findTarget(): Target | null {
  if (!localPlayer.initialized) return null;
  if (localPlayer.zone === STREET) {
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
  const interior = gameData.interiors.get(localPlayer.zone);
  const station = interior ? nearestStation(localPlayer, interior) : null;
  return station ? stationTarget(station) : null;
}

/** Bouton ACTION contextuel (porte d'un lieu, poste d'intérieur) + toast de la réponse serveur. */
export function Interaction({ room }: { room: GameRoom }) {
  const [target, setTarget] = useState<Target | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const targetRef = useRef<Target | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      const next = findTarget();
      const prev = targetRef.current;
      if (next?.key !== prev?.key || next?.label !== prev?.label || next?.active !== prev?.active) {
        targetRef.current = next;
        setTarget(next);
      }
    }, PROBE_MS);
    return () => clearInterval(id);
  }, []);

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
    () => connection.onNotice((n) => setToast({ key: Date.now(), ok: n.ok, text: n.text })),
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
      {toast && (
        <div key={toast.key} className={`toast${toast.ok ? '' : ' bad'}`}>
          {toast.text}
        </div>
      )}
    </>
  );
}
