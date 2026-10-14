import { useEffect, useRef, useState } from 'react';
import { ClientMsg, count, gameData, type SaleOfferMessage } from '@narco/shared';
import { connection, type GameRoom } from '../net/connection';
import { gameNow, readBag, useRoomVersion } from '../net/gameView';

/** Rafraîchissement de la jauge de patience (ms). */
const PATIENCE_REFRESH_MS = 200;

/**
 * Offre d'un PNJ : quantité (− / +), prix unitaire, total, Accepter / Refuser. Prix et quantité
 * maximale viennent du serveur ; le client n'affiche que des multiplications pour l'aperçu, le
 * montant réel est calculé par le serveur à l'acceptation.
 */
export function SalePanel({ room }: { room: GameRoom }) {
  const [offer, setOffer] = useState<SaleOfferMessage | null>(null);
  const [qty, setQty] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState(1);
  const total = useRef(1);
  useRoomVersion(room); // re-rendu quand le sac change (pochons disponibles)

  useEffect(
    () =>
      connection.onSale((e) => {
        if ('offer' in e) {
          setOffer(e.offer);
          setError(null);
          total.current = Math.max(1, e.offer.expiresAt - gameNow());
          const have = count(readBag(room, connection.playerId), e.offer.pouchId);
          setQty(Math.max(1, Math.min(e.offer.maxQty, have)));
        } else {
          setOffer((o) => (o?.npcId === e.closed.npcId ? null : o));
        }
      }),
    [room],
  );

  // Refus serveur pendant que le panneau est ouvert : affiché dans le panneau.
  useEffect(
    () =>
      connection.onNotice((n) => {
        if (!n.ok) setError(n.text);
      }),
    [],
  );

  useEffect(() => {
    if (!offer) return;
    const tick = () =>
      setLeft(Math.max(0, Math.min(1, (offer.expiresAt - gameNow()) / total.current)));
    tick();
    const id = setInterval(tick, PATIENCE_REFRESH_MS);
    return () => clearInterval(id);
  }, [offer]);

  if (!offer) return null;
  const pouch = gameData.items.get(offer.pouchId);
  const have = count(readBag(room, connection.playerId), offer.pouchId);
  const send = (type: string, body: object) => {
    if (room.connection.isOpen) room.send(type, body);
  };

  return (
    <div className="sale-panel" role="dialog" aria-label={`Offre de ${offer.name}`}>
      <h3>
        💬 {offer.name} veut {offer.maxQty} × {pouch?.name ?? offer.pouchId}
      </h3>
      <div className="patience" aria-hidden>
        <i style={{ width: `${Math.round(left * 100)}%` }} />
      </div>
      <div className="sale-row">
        <span>Quantité (tu en as {have})</span>
        <div className="qty">
          <button
            type="button"
            className="btn"
            disabled={qty <= 1}
            onClick={() => setQty((q) => Math.max(1, q - 1))}
          >
            −
          </button>
          <strong>{qty}</strong>
          <button
            type="button"
            className="btn"
            disabled={qty >= offer.maxQty}
            onClick={() => setQty((q) => Math.min(offer.maxQty, q + 1))}
          >
            +
          </button>
        </div>
      </div>
      <div className="sale-row">
        <span>Prix unitaire</span>
        <span>{offer.unitPrice} $</span>
      </div>
      <div className="sale-row">
        <span>Total</span>
        <span className="sale-total">{qty * offer.unitPrice} $</span>
      </div>
      {error && <div className="sale-error">{error}</div>}
      <div className="sale-actions">
        <button
          type="button"
          className="btn"
          onClick={() => send(ClientMsg.SaleDecline, { npcId: offer.npcId })}
        >
          Refuser
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={have < qty}
          onClick={() => send(ClientMsg.SaleAccept, { npcId: offer.npcId, qty })}
        >
          Accepter
        </button>
      </div>
    </div>
  );
}
