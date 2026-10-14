import { useState } from 'react';
import { ClientMsg, gameData, type DebugMessage } from '@narco/shared';
import { connection } from '../net/connection';
import { gameScale, useRoomVersion } from '../net/gameView';

const STORABLE = [...gameData.items.values()].filter((it) => it.storage === 'slot');

function send(msg: DebugMessage): void {
  const room = connection.getSnapshot().room;
  if (room?.connection.isOpen) room.send(ClientMsg.Debug, msg);
}

/** Commandes debug du labo (le serveur les refuse si config.debug.commands est faux). */
export function DebugLabSection() {
  useRoomVersion(connection.getSnapshot().room); // suit la vitesse du temps diffusée par le serveur
  const [itemId, setItemId] = useState(STORABLE[0]?.id ?? '');
  const [qty, setQty] = useState(5);
  const scale = gameScale();

  return (
    <>
      <div className="cam-section">Debug labo</div>
      <div className="dbg-row">
        <select className="dbg-select" value={itemId} onChange={(e) => setItemId(e.target.value)}>
          {STORABLE.map((it) => (
            <option key={it.id} value={it.id}>
              {it.icon} {it.name}
            </option>
          ))}
        </select>
        <div className="segmented">
          {[1, 5, 20].map((n) => (
            <button
              key={n}
              type="button"
              className={qty === n ? 'active' : ''}
              onClick={() => setQty(n)}
            >
              ×{n}
            </button>
          ))}
        </div>
      </div>
      <div className="cam-actions">
        <button
          type="button"
          className="btn primary"
          onClick={() => send({ cmd: 'give', itemId, qty })}
        >
          Donner
        </button>
        <button type="button" className="btn danger" onClick={() => send({ cmd: 'clearStock' })}>
          Vider le stock
        </button>
      </div>
      <div className="dbg-row">
        <span>Temps</span>
        <div className="segmented">
          {gameData.config.debug.timeScales.map((s) => (
            <button
              key={s}
              type="button"
              className={scale === s ? 'active' : ''}
              onClick={() => send({ cmd: 'timeScale', scale: s })}
            >
              x{s}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
