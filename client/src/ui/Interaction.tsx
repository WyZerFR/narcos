import { useEffect, useRef, useState } from 'react';
import { ClientMsg, gameData, nearestLocation, type InteractMessage } from '@narco/shared';
import { connection, type GameRoom } from '../net/connection';
import { localPlayer } from '../game/localPlayer';
import { ActionButton } from '../input/ActionButton';
import { onAction } from '../input/inputState';

const LOCATIONS = [...gameData.locations.values()];
/** Fréquence de recherche du lieu proche (pas besoin de 60 Hz pour un libellé). */
const PROBE_MS = 160;
const TOAST_MS = 3500;

interface Toast {
  key: number;
  ok: boolean;
  text: string;
}

/** Bouton ACTION contextuel (« Entrer : <lieu> ») + toast de la réponse serveur. */
export function Interaction({ room }: { room: GameRoom }) {
  const [nearId, setNearId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const nearRef = useRef<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      const loc = localPlayer.initialized ? nearestLocation(localPlayer, LOCATIONS) : null;
      const next = loc?.id ?? null;
      if (next !== nearRef.current) {
        nearRef.current = next;
        setNearId(next);
      }
    }, PROBE_MS);
    return () => clearInterval(id);
  }, []);

  // L'intention part au serveur, qui vérifie la distance et répond par une notice.
  useEffect(
    () =>
      onAction(() => {
        const locationId = nearRef.current;
        if (!locationId || !room.connection.isOpen) return;
        const msg: InteractMessage = { locationId };
        room.send(ClientMsg.Interact, msg);
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

  const near = nearId ? gameData.locations.get(nearId) : undefined;
  return (
    <>
      <ActionButton label={near ? `Entrer : ${near.name}` : 'ACTION'} active={Boolean(near)} />
      {toast && (
        <div key={toast.key} className={`toast${toast.ok ? '' : ' bad'}`}>
          {toast.text}
        </div>
      )}
    </>
  );
}
