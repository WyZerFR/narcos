import { useState } from 'react';
import { ClientMsg, gameData, type DebugMessage } from '@narco/shared';
import { connection } from '../net/connection';
import { gameScale, useRoomVersion } from '../net/gameView';

const STORABLE = [...gameData.items.values()].filter((it) => it.storage === 'slot');
const PLACEABLE = STORABLE.filter((it) => it.placeable);

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
  const survivalScale = connection.getSnapshot().room?.state.clock?.survivalScale ?? 1;

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
      </div>
      <div className="cam-actions">
        <button type="button" className="btn" onClick={() => send({ cmd: 'spawnBuyer' })}>
          Acheteur ici
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => send({ cmd: 'give', itemId: 'pouch_base', qty: 5 })}
        >
          +5 pochons
        </button>
      </div>
      <div className="cam-actions">
        <button type="button" className="btn" onClick={() => send({ cmd: 'equipLab' })}>
          Équiper le labo
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            for (const it of PLACEABLE) send({ cmd: 'give', itemId: it.id, qty: 1 });
          }}
        >
          +1 meuble de chaque
        </button>
        <button type="button" className="btn danger" onClick={() => send({ cmd: 'clearLab' })}>
          Vider le labo
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

      <div className="cam-section">Debug argent, survie, magasins</div>
      <div className="cam-actions">
        <button
          type="button"
          className="btn primary"
          onClick={() => send({ cmd: 'money', amount: 1000 })}
        >
          +1000 $ sale
        </button>
        <button type="button" className="btn" onClick={() => send({ cmd: 'restock' })}>
          Réappro.
        </button>
      </div>
      <div className="cam-actions">
        <button type="button" className="btn" onClick={() => send({ cmd: 'vitals', mode: 'fill' })}>
          Jauges pleines
        </button>
        <button
          type="button"
          className="btn danger"
          onClick={() => send({ cmd: 'vitals', mode: 'empty' })}
        >
          Jauges vides
        </button>
      </div>
      <div className="dbg-row">
        <span>Survie</span>
        <div className="segmented">
          {gameData.config.debug.timeScales.map((s) => (
            <button
              key={s}
              type="button"
              className={survivalScale === s ? 'active' : ''}
              onClick={() => send({ cmd: 'survivalScale', scale: s })}
            >
              x{s}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
