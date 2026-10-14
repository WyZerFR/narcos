import { useState } from 'react';
import { STREET } from '@narco/shared';
import type { GameRoom, Snapshot } from '../net/connection';
import { connection } from '../net/connection';
import { useRoomPlayers } from '../game/Players';
import { LabelLayer } from '../game/labels';
import { SettingsPanel } from './SettingsPanel';
import { Minimap } from './Minimap';

export function Hud({ snapshot, room }: { snapshot: Snapshot; room: GameRoom }) {
  const players = useRoomPlayers(room);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const me = connection.playerId;
  const myZone = players.find((p) => p.id === me)?.zone ?? STREET;

  return (
    <>
      <LabelLayer players={players} myId={me} zone={myZone} />
      <div className="hud-top">
        <div className="hud-left">
          <div className="hud-card">
            <div className="room-code">
              Partie <strong>{snapshot.code}</strong>
            </div>
            <ul className="player-list">
              {players.map((p) => (
                <li key={p.id} className={p.connected ? '' : 'offline'}>
                  <span className="dot" style={{ background: p.color }} />
                  {p.name}
                  {p.id === me ? ' (toi)' : ''}
                  {!p.connected && ' · hors ligne'}
                </li>
              ))}
            </ul>
          </div>
          {myZone === STREET && <Minimap room={room} />}
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label="Options"
          onClick={() => setSettingsOpen(true)}
        >
          ⚙
        </button>
      </div>

      {snapshot.status === 'reconnecting' && (
        <div className="banner">Reconnexion… (tentative {snapshot.attempt})</div>
      )}

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </>
  );
}
