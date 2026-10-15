import { useEffect, useRef, useState } from 'react';
import {
  ClientMsg,
  count,
  DIRTY_CASH,
  gameData,
  launderRemaining,
  launderSplit,
  type BankLaunderMessage,
  type LaunderVenue,
} from '@narco/shared';
import { connection, type GameRoom } from '../net/connection';
import { gameNow, readBag, useRoomVersion } from '../net/gameView';
import { localPlayer, stillAt } from '../game/localPlayer';

const LAUNDER = gameData.economy.launder;
const TITLE: Record<LaunderVenue, string> = {
  bank: "🏦 Blanchir de l'argent",
  cellar: '🧺 Lessive du blanchisseur',
};

/**
 * Panneau de blanchiment d'un lieu (guichet de la banque, bureau du blanchisseur) : montant sale
 * (− / +, montants rapides, « Tout »), commission, net et plafond restant du lieu pour l'aperçu.
 * Le serveur recalcule et valide tout (zone, proximité, compte, sac, plafond du lieu).
 */
export function LaunderPanel({ room }: { room: GameRoom }) {
  const [open, setOpen] = useState<{
    stationId: string;
    venue: LaunderVenue;
    zone: string;
  } | null>(null);
  const [amount, setAmount] = useState(0);
  const [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nextId = useRef(1);
  const pendingRef = useRef<number | null>(null);
  useRoomVersion(room); // sac et solde relus quand l'état change

  const me = room.state.players?.get(connection.playerId);
  const dirty = count(readBag(room, connection.playerId), DIRTY_CASH);
  const venue = open?.venue ?? 'bank';
  const RULES = LAUNDER.venues[venue];
  const log = venue === 'bank' ? me?.launderLog : me?.cellarLaunderLog;
  const left = me ? launderRemaining([...(log ?? [])], gameNow(), RULES) : 0;
  const max = Math.min(dirty, left);

  useEffect(
    () =>
      connection.onLaunder((e) => {
        if ('open' in e) {
          setOpen({ stationId: e.open.stationId, venue: e.open.venue, zone: localPlayer.zone });
          setError(null);
          pendingRef.current = null;
          setPending(null);
          setAmount(0);
        } else if (e.result.requestId === pendingRef.current) {
          pendingRef.current = null;
          setPending(null);
          if (e.result.ok) setOpen(null);
          else setError(e.result.text);
        }
      }),
    [],
  );

  // sortie de la pièce ou du rayon de sortie du guichet : panneau fermé
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => {
      if (!stillAt(open.zone, open.stationId)) setOpen(null);
    }, 250);
    return () => clearInterval(id);
  }, [open]);

  if (!open) return null;
  const value = Math.min(amount, max);
  const { commission, net } = launderSplit(value, RULES.fee);
  const set = (v: number) => {
    setAmount(Math.max(0, Math.min(max, v)));
    setError(null);
  };
  const confirm = () => {
    if (!room.connection.isOpen || pending !== null || value <= 0) return;
    const requestId = nextId.current++;
    const msg: BankLaunderMessage = { requestId, stationId: open.stationId, amount: value };
    room.send(ClientMsg.BankLaunder, msg);
    pendingRef.current = requestId;
    setPending(requestId);
  };

  return (
    <div className="sale-panel launder-panel" role="dialog" aria-label="Blanchir">
      <h3>{TITLE[venue]}</h3>
      <div className="sale-row">
        <span>Espèces sales : {dirty} $</span>
        <span>Plafond restant : {left} $</span>
      </div>
      <div className="sale-row">
        <span>Montant</span>
        <div className="qty">
          <button
            type="button"
            className="btn"
            disabled={value <= 0}
            onClick={() => set(value - LAUNDER.step)}
          >
            −
          </button>
          <strong>{value} $</strong>
          <button
            type="button"
            className="btn"
            disabled={value >= max}
            onClick={() => set(value + LAUNDER.step)}
          >
            +
          </button>
        </div>
      </div>
      <div className="launder-quick">
        {LAUNDER.quickAmounts.map((q) => (
          <button key={q} type="button" className="btn" disabled={max <= 0} onClick={() => set(q)}>
            {q}
          </button>
        ))}
        <button type="button" className="btn" disabled={max <= 0} onClick={() => set(max)}>
          Tout
        </button>
      </div>
      <div className="sale-row">
        <span>Commission ({Math.round(RULES.fee * 100)} %)</span>
        <span>− {commission} $</span>
      </div>
      <div className="sale-row">
        <span>Crédité sur le compte</span>
        <span className="sale-total">{net} $</span>
      </div>
      {error && <div className="sale-error">{error}</div>}
      <div className="sale-actions">
        <button type="button" className="btn" onClick={() => setOpen(null)}>
          Annuler
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={value <= 0 || pending !== null}
          onClick={confirm}
        >
          {pending !== null ? 'Envoi…' : 'Valider'}
        </button>
      </div>
    </div>
  );
}
