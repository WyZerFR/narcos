import {
  ClientMsg,
  gameData,
  nearestStation,
  type CartRemoveMessage,
  type StationMessage,
} from '@narco/shared';
import { connection, type GameRoom } from '../net/connection';
import { useRoomVersion } from '../net/gameView';
import { localPlayer } from '../game/localPlayer';

/**
 * Panier du magasin : lignes, « Retirer », total et « Payer ». Tous les montants viennent du
 * serveur (`cart`, `cartTotal`) ; « Payer » n'est actif qu'à portée du comptoir.
 */
export function CartPanel({ room, interiorId }: { room: GameRoom; interiorId: string }) {
  useRoomVersion(room); // re-rendu à chaque patch (panier, et position pour « Payer »)
  const me = room.state.players?.get(connection.playerId);
  const interior = gameData.interiors.get(interiorId);
  if (!me || !interior) return null;
  const lines = [...(me.cart ?? [])];
  const counter = interior.stations.find((s) => s.kind === 'counter');
  const atCounter = counter ? nearestStation(localPlayer, interior)?.id === counter.id : false;

  const remove = (stationId: string) => {
    const msg: CartRemoveMessage = { stationId };
    room.send(ClientMsg.CartRemove, msg);
  };
  const payNow = () => {
    if (!counter) return;
    const msg: StationMessage = { stationId: counter.id, action: 'pay' };
    room.send(ClientMsg.Station, msg);
  };

  return (
    <div className="cart-panel">
      <h3>🛒 Panier</h3>
      {lines.length === 0 ? (
        <p className="cart-empty">Vide. Approche-toi d’une étagère.</p>
      ) : (
        <ul>
          {lines.map((l) => {
            const def = gameData.items.get(l.itemId);
            return (
              <li key={l.stationId}>
                <span className="cart-item">
                  {def?.icon} {def?.name ?? l.itemId} ×{l.qty}
                </span>
                <span className="cart-price">{l.unitPrice} $/u</span>
                <button
                  type="button"
                  className="btn cart-remove"
                  onClick={() => remove(l.stationId)}
                >
                  Retirer
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="cart-footer">
        <strong>Total : {me.cartTotal} $</strong>
        <button
          type="button"
          className="btn primary"
          disabled={!atCounter || lines.length === 0}
          onClick={payNow}
          title={atCounter ? undefined : 'Va au comptoir pour payer'}
        >
          {atCounter ? 'Payer' : 'Payer au comptoir'}
        </button>
      </div>
    </div>
  );
}
