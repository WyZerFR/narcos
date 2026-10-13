import { useEffect, useRef, useSyncExternalStore } from 'react';
import { connection, type GameRoom } from './net/connection';
import { bindKeyboard } from './input/keyboard';
import { Joystick } from './input/Joystick';
import { ActionButton } from './input/ActionButton';
import { Scene } from './game/Scene';
import { Lobby } from './ui/Lobby';
import { Hud } from './ui/Hud';
import { DebugOverlay } from './ui/DebugOverlay';
import { useSettings } from './ui/settings';
import { CameraPanel } from './ui/CameraPanel';

/** Le panneau caméra n'existe qu'avec ?debug=1 dans l'URL (pas via le réglage Options). */
const DEBUG_URL = (() => {
  const p = new URLSearchParams(location.search).get('debug');
  return p !== null && p !== '0';
})();

export function App() {
  const snapshot = useSyncExternalStore(connection.subscribe, connection.getSnapshot);
  const { debug } = useSettings();

  // Pendant une reconnexion on garde la dernière room affichée (figée) sous le bandeau.
  const lastRoom = useRef<GameRoom | null>(null);
  if (snapshot.room) lastRoom.current = snapshot.room;
  if (snapshot.status === 'idle' || snapshot.status === 'connecting') lastRoom.current = null;
  const room = snapshot.room ?? lastRoom.current;

  useEffect(() => bindKeyboard(), []);
  useEffect(() => connection.resumeSavedRoom(), []);

  return (
    <>
      {room ? (
        <>
          <Scene room={room} />
          <Hud snapshot={snapshot} room={room} />
          <Joystick />
          <ActionButton />
          {DEBUG_URL && <CameraPanel />}
        </>
      ) : snapshot.status === 'reconnecting' ? (
        <div className="lobby">
          <p className="status">Retour dans la partie {snapshot.code}…</p>
          <button type="button" className="btn" onClick={() => void connection.leave()}>
            Annuler
          </button>
        </div>
      ) : (
        <Lobby snapshot={snapshot} />
      )}
      {debug && <DebugOverlay />}
      <div className="rotate-device">
        <div>📱↻</div>
        <p>Tourne ton appareil en paysage</p>
      </div>
    </>
  );
}
