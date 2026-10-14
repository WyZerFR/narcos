import { useState } from 'react';
import { gameData, STREET } from '@narco/shared';
import type { GameRoom, Snapshot } from '../net/connection';
import { connection } from '../net/connection';
import { useRoomPlayers } from '../game/Players';
import { LabelLayer } from '../game/labels';
import { SettingsPanel } from './SettingsPanel';
import { Minimap } from './Minimap';
import { StatusPanel } from './StatusPanel';
import { CartPanel } from './CartPanel';
import { InventoryPanel } from './InventoryPanel';
import { SalePanel } from './SalePanel';
import { openInventory, useInventoryMode } from './uiStore';

export function Hud({ snapshot, room }: { snapshot: Snapshot; room: GameRoom }) {
  const players = useRoomPlayers(room);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const me = connection.playerId;
  const myZone = players.find((p) => p.id === me)?.zone ?? STREET;
  const inventory = useInventoryMode();

  return (
    <>
      <LabelLayer room={room} players={players} myId={me} zone={myZone} />
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
            <StatusPanel room={room} />
          </div>
          {gameData.shops.has(myZone) && <CartPanel room={room} interiorId={myZone} />}
          {myZone === STREET && <Minimap room={room} />}
        </div>
        <div className="hud-right">
          <button
            type="button"
            className="icon-btn"
            aria-label="Sac"
            onClick={() => openInventory('bag')}
          >
            🎒
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Options"
            onClick={() => setSettingsOpen(true)}
          >
            ⚙
          </button>
        </div>
      </div>

      {snapshot.status === 'reconnecting' && (
        <div className="banner">Reconnexion… (tentative {snapshot.attempt})</div>
      )}

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      {inventory && <InventoryPanel room={room} mode={inventory} />}
      <SalePanel room={room} />
    </>
  );
}
