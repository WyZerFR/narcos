import { useState } from 'react';
import { ClientMsg, gameData, type DebugMessage } from '@narco/shared';
import { connection } from '../net/connection';
import { setAreaBoundsVisible, useAreaBoundsVisible } from '../game/AreaBounds';

const AREAS = [...gameData.areas.values()];
const GARDENS = [...gameData.quartierLayouts.values()].flatMap((l) => l.gardens);
/** Pas de réglage du multiplicateur de prix (debug). */
const PRICE_STEP = 0.05;
/** Pas de réglage de la commission du blanchisseur (debug). */
const FEE_STEP = 0.05;

function send(msg: DebugMessage): void {
  const room = connection.getSnapshot().room;
  if (room?.connection.isOpen) room.send(ClientMsg.Debug, msg);
}

/** Debug quartiers : téléportation, frontières des areas, multiplicateur de prix à chaud. */
export function DebugQuartierSection() {
  const bounds = useAreaBoundsVisible();
  const [prices, setPrices] = useState<Record<string, number>>(() =>
    Object.fromEntries(AREAS.map((a) => [a.id, a.priceMultiplier])),
  );
  const change = (areaId: string, delta: number) => {
    const value = Math.round(((prices[areaId] ?? 1) + delta) * 100) / 100;
    setPrices((p) => ({ ...p, [areaId]: value }));
    send({ cmd: 'priceMultiplier', areaId, value });
  };

  const [cellarFee, setCellarFee] = useState(gameData.economy.launder.venues.cellar.fee);
  const changeFee = (delta: number) => {
    const value = Math.round(Math.min(0.95, Math.max(0, cellarFee + delta)) * 100) / 100;
    setCellarFee(value);
    send({ cmd: 'launderFee', venue: 'cellar', value });
  };

  return (
    <>
      <div className="cam-section">Debug quartiers</div>
      <div className="cam-actions">
        {AREAS.map((a) => (
          <button
            key={a.id}
            type="button"
            className="btn"
            onClick={() => send({ cmd: 'teleport', areaId: a.id })}
          >
            → {a.name}
          </button>
        ))}
        <button type="button" className="btn" onClick={() => send({ cmd: 'teleportTrapdoor' })}>
          → Trappe
        </button>
        {GARDENS.map((g, index) => (
          <button
            key={index}
            type="button"
            className="btn"
            onClick={() => send({ cmd: 'teleportGarden', index })}
          >
            → Jardin {index + 1} ({g.kind === 'real' ? 'vrai' : 'leurre'})
          </button>
        ))}
        <button
          type="button"
          className="btn"
          onClick={() => send({ cmd: 'resetLaunderCap', venue: 'cellar' })}
        >
          Plafond cave à zéro
        </button>
        <button
          type="button"
          className={`btn${bounds ? ' primary' : ''}`}
          onClick={() => setAreaBoundsVisible(!bounds)}
        >
          Frontières {bounds ? 'ON' : 'OFF'}
        </button>
      </div>
      <div className="dbg-row">
        <span>Commission cave : {Math.round(cellarFee * 100)} %</span>
        <div className="segmented">
          <button type="button" onClick={() => changeFee(-FEE_STEP)}>
            −
          </button>
          <button type="button" onClick={() => changeFee(FEE_STEP)}>
            +
          </button>
        </div>
      </div>
      {AREAS.map((a) => (
        <div key={a.id} className="dbg-row">
          <span>
            {a.name} : prix ×{(prices[a.id] ?? 1).toFixed(2)}
          </span>
          <div className="segmented">
            <button type="button" onClick={() => change(a.id, -PRICE_STEP)}>
              −
            </button>
            <button type="button" onClick={() => change(a.id, PRICE_STEP)}>
              +
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
