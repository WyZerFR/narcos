import { useEffect, useRef, useSyncExternalStore } from 'react';
import { connection, type GameRoom } from './net/connection';
import { bindKeyboard } from './input/keyboard';
import { Joystick } from './input/Joystick';
import { Interaction } from './ui/Interaction';
import { Scene } from './game/Scene';
import { Lobby } from './ui/Lobby';
import { Hud } from './ui/Hud';
import { DebugOverlay } from './ui/DebugOverlay';
import { useSettings } from './ui/settings';
import { CameraPanel } from './ui/CameraPanel';
import { PlacementPanel } from './ui/PlacementPanel';
import { usePlacement } from './ui/placementStore';

export function App() {
  const snapshot = useSyncExternalStore(connection.subscribe, connection.getSnapshot);
  const { debug } = useSettings();
  const placing = usePlacement() !== null;

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
          {/* mode placement : flèches et boutons à la place du joystick et d'ACTION */}
          {!placing && <Joystick />}
          <Interaction room={room} />
          {placing && <PlacementPanel room={room} />}
          {debug && <CameraPanel />}
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
