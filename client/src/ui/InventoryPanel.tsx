import { useCallback, useEffect, useState } from 'react';
import {
  ClientMsg,
  gameData,
  type Inventory,
  type InventoryKind,
  type UseMessage,
} from '@narco/shared';
import { connection, type GameRoom } from '../net/connection';
import { readBag, useRoomVersion } from '../net/gameView';
import { closeInventory } from './uiStore';
import { startPlacingItem } from './placementStore';
import { useInventoryDrag } from './useInventoryDrag';

type Drag = ReturnType<typeof useInventoryDrag>;
/** Durée d'affichage d'un refus de déplacement (style). */
const ERROR_MS = 2500;

type Side = InventoryKind;

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
 * Inventaire plein écran : grille du sac seul (le stock commun reviendra avec la caisse).
 * Tap pour sélectionner (détail, manger / boire) ; appui long pour glisser une pile vers un
 * autre slot (déplacement, fusion, échange).
 */
export function InventoryPanel({ room }: { room: GameRoom }) {
  useRoomVersion(room); // re-rendu à chaque patch : le sac peut changer sous nos yeux
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
  const myZone = room.state.players?.get(connection.playerId)?.zone ?? '';
  const inLab = gameData.interiors.get(myZone)?.furnishable ?? false;
  const stack = selection ? bag[selection.slot] : null;
  const def = stack ? gameData.items.get(stack.itemId) : undefined;

  /** Manger / boire : le serveur applique la restauration et retire l'objet. */
  const useItem = () => {
    if (!selection) return;
    const msg: UseMessage = { slot: selection.slot };
    room.send(ClientMsg.Use, msg);
  };

  return (
    <div className="inv-backdrop">
      <div className="inv-panel">
        <header className="inv-header">
          <h2>Mon sac</h2>
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
              {def.use?.action === 'place' && (
                <div className="inv-actions">
                  <button
                    type="button"
                    className="btn primary inv-use"
                    disabled={!inLab}
                    onClick={() => {
                      closeInventory();
                      startPlacingItem(stack.itemId);
                    }}
                  >
                    {def.use.label}
                  </button>
                  {!inLab && <p className="inv-use-hint">À poser dans ton labo</p>}
                </div>
              )}
              {def.restores && (
                <div className="inv-actions">
                  <button type="button" className="btn primary" onClick={useItem}>
                    {(def.restores.hunger ?? 0) >= (def.restores.thirst ?? 0) ? 'Manger' : 'Boire'}
                  </button>
                </div>
              )}
            </>
          ) : (
            <p className="inv-hint">Touche un objet pour voir son détail.</p>
          )}
        </footer>
      </div>
    </div>
  );
}
