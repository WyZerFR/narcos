import { useCallback, useEffect, useState } from 'react';
import {
  ClientMsg,
  gameData,
  type Inventory,
  type TransferMessage,
  type UseMessage,
} from '@narco/shared';
import { connection, type GameRoom } from '../net/connection';
import { readBag, readStock, useRoomVersion } from '../net/gameView';
import { closeInventory, type InventoryMode } from './uiStore';
import { useInventoryDrag } from './useInventoryDrag';

type Drag = ReturnType<typeof useInventoryDrag>;
/** Durée d'affichage d'un refus de déplacement (style). */
const ERROR_MS = 2500;

type Side = 'bag' | 'stock';

interface Selection {
  side: Side;
  slot: number;
}

function Grid({
  title,
  inv,
  side,
  selection,
  onSelect,
  columns,
  drag,
}: {
  title: string;
  inv: Inventory;
  side: Side;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
  columns: number;
  drag: Drag;
}) {
  const used = inv.filter(Boolean).length;
  return (
    <section className={`inv-grid-wrap ${side}`}>
      <h3>
        {title}{' '}
        <small>
          {used}/{inv.length}
        </small>
      </h3>
      <div className="inv-grid" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
        {inv.map((stack, slot) => {
          const def = stack ? gameData.items.get(stack.itemId) : undefined;
          const selected = selection?.side === side && selection.slot === slot;
          return (
            <button
              key={slot}
              type="button"
              data-inv={side}
              data-slot={slot}
              className={`inv-slot${stack ? '' : ' empty'}${selected ? ' selected' : ''}${
                drag.draggingFrom?.inv === side && drag.draggingFrom.slot === slot ? ' lifted' : ''
              }`}
              onClick={() => {
                if (drag.consumeClick()) onSelect({ side, slot });
              }}
              onContextMenu={(e) => e.preventDefault()}
              onPointerDown={(e) => {
                if (stack)
                  drag.slotHandlers.onPointerDown(e, { inv: side, slot }, stack.itemId, stack.qty);
              }}
              onPointerMove={drag.slotHandlers.onPointerMove}
              onPointerUp={drag.slotHandlers.onPointerUp}
              onPointerCancel={drag.slotHandlers.onPointerCancel}
              aria-label={def ? `${def.name} × ${stack!.qty}` : 'Slot vide'}
            >
              {def && (
                <>
                  <span className="inv-icon">{def.icon}</span>
                  <span className="inv-qty">{stack!.qty}</span>
                </>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Inventaire plein écran : grille du sac ; à la caisse du labo, sac et stock côte à côte.
 * Tap pour sélectionner (détail, boutons de transfert) ; appui long pour glisser une pile
 * vers un autre slot (déplacement, fusion, échange, transfert sac ↔ stock à la caisse).
 */
export function InventoryPanel({
  room,
  mode,
}: {
  room: GameRoom;
  mode: Exclude<InventoryMode, null>;
}) {
  useRoomVersion(room); // re-rendu à chaque patch : le stock peut changer sous nos yeux
  const [selection, setSelection] = useState<Selection | null>(null);
  const [dragError, setDragError] = useState<string | null>(null);
  const onRefused = useCallback((text: string) => setDragError(text), []);
  const drag = useInventoryDrag(room, onRefused);
  useEffect(() => {
    if (!dragError) return;
    const t = setTimeout(() => setDragError(null), ERROR_MS);
    return () => clearTimeout(t);
  }, [dragError]);
  const bag = readBag(room, connection.playerId);
  const stock = readStock(room);
  const showStock = mode === 'stock';

  const selectedInv = selection?.side === 'stock' ? stock : bag;
  const stack = selection ? selectedInv[selection.slot] : null;
  const def = stack ? gameData.items.get(stack.itemId) : undefined;

  const send = (qty: number) => {
    if (!selection || !stack) return;
    const msg: TransferMessage = { from: selection.side, slot: selection.slot, qty };
    room.send(ClientMsg.Transfer, msg);
  };
  const target = selection?.side === 'bag' ? 'Stock' : 'Sac';
  /** Manger / boire : le serveur applique la restauration et retire l'objet. */
  const useItem = () => {
    if (!selection || selection.side !== 'bag') return;
    const msg: UseMessage = { slot: selection.slot };
    room.send(ClientMsg.Use, msg);
  };

  return (
    <div className="inv-backdrop">
      <div className={`inv-panel${showStock ? ' with-stock' : ''}`}>
        <header className="inv-header">
          <h2>{showStock ? 'Sac ↔ Caisse du stock' : 'Mon sac'}</h2>
          <button type="button" className="btn" onClick={closeInventory}>
            Fermer
          </button>
        </header>

        <div className="inv-body">
          <Grid
            title="🎒 Sac"
            inv={bag}
            side="bag"
            selection={selection}
            onSelect={setSelection}
            columns={5}
            drag={drag}
          />
          {showStock && (
            <Grid
              title="📦 Stock commun"
              inv={stock}
              side="stock"
              selection={selection}
              onSelect={setSelection}
              columns={10}
              drag={drag}
            />
          )}
        </div>

        {dragError && <div className="inv-error">{dragError}</div>}
        {drag.ghostNode}
        <footer className="inv-detail">
          {def && stack ? (
            <>
              <div className="inv-detail-text">
                <strong>
                  {def.icon} {def.name} × {stack.qty}
                </strong>
                <p>{def.description}</p>
              </div>
              {selection?.side === 'bag' && def.restores && (
                <div className="inv-actions">
                  <button type="button" className="btn primary" onClick={useItem}>
                    {(def.restores.hunger ?? 0) >= (def.restores.thirst ?? 0) ? 'Manger' : 'Boire'}
                  </button>
                </div>
              )}
              {showStock && (
                <div className="inv-actions">
                  <button type="button" className="btn" onClick={() => send(1)}>
                    → {target} (1)
                  </button>
                  <button type="button" className="btn primary" onClick={() => send(stack.qty)}>
                    → {target} (tout)
                  </button>
                </div>
              )}
            </>
          ) : (
            <p className="inv-hint">
              Touche un objet pour voir son détail{showStock ? ', puis transfère-le.' : '.'}
            </p>
          )}
        </footer>
      </div>
    </div>
  );
}
