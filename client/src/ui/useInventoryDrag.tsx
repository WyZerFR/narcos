import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ClientMsg, gameData, type InventoryKind, type InventoryMoveMessage } from '@narco/shared';
import { connection, type GameRoom } from '../net/connection';

const { longPressMs, dragCancelPx, moveTimeoutMs } = gameData.config.ui;
/** Durée du retour du fantôme vers son slot après un refus ou une annulation (style). */
const RETURN_MS = 220;

export interface SlotRef {
  inv: InventoryKind;
  slot: number;
}

interface Ghost {
  itemId: string;
  qty: number;
  from: SlotRef;
  /** Le fantôme repart vers son slot (annulation ou refus serveur). */
  returning: boolean;
}

/** Slot sous un point de l'écran (les cases portent `data-inv` et `data-slot`). */
function slotAt(x: number, y: number): SlotRef | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-inv][data-slot]');
  if (!el) return null;
  return { inv: el.dataset.inv as InventoryKind, slot: Number(el.dataset.slot) };
}

function slotRect(ref: SlotRef): DOMRect | null {
  return (
    document
      .querySelector<HTMLElement>(`[data-inv="${ref.inv}"][data-slot="${ref.slot}"]`)
      ?.getBoundingClientRect() ?? null
  );
}

/** Bloque le défilement iOS pendant un glisser (écouteur non passif). */
const blockScroll = (e: TouchEvent) => e.preventDefault();

/**
 * Glisser-déposer par appui long, sans dépendance : Pointer Events + `setPointerCapture`.
 * - appui court : rien ici, le clic garde son rôle (sélection) ;
 * - mouvement > `dragCancelPx` avant `longPressMs` : appui annulé, la grille défile ;
 * - appui long : un fantôme suit le doigt ; au lâcher sur un slot → message `inventory.move`
 *   (le serveur décide) ; hors grille ou refus → le fantôme revient à son slot.
 */
export function useInventoryDrag(room: GameRoom, onRefused: (text: string) => void) {
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const ghostEl = useRef<HTMLDivElement>(null);
  const press = useRef<{
    id: number;
    x: number;
    y: number;
    from: SlotRef;
    itemId: string;
    qty: number;
    target: HTMLElement;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const dragging = useRef(false);
  /** Le clic qui suit un glisser ne doit pas sélectionner. */
  const swallowClick = useRef(false);
  const pending = useRef<number | null>(null);
  /** Filet de sécurité : une réponse perdue (reconnexion…) ne doit pas bloquer tout glisser. */
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Slot d'origine du dernier dépôt envoyé (pour y renvoyer le fantôme en cas de refus). */
  const dropFrom = useRef<SlotRef | null>(null);
  const requestId = useRef(1);

  const placeGhost = (x: number, y: number) => {
    const el = ghostEl.current;
    if (el) el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
  };

  /** Renvoie le fantôme vers son slot d'origine puis le retire. */
  const returnGhost = (from: SlotRef) => {
    const r = slotRect(from);
    setGhost((g) => (g ? { ...g, returning: true } : g));
    if (r) placeGhost(r.left + r.width / 2, r.top + r.height / 2);
    setTimeout(() => setGhost(null), RETURN_MS);
  };

  const endDrag = () => {
    dragging.current = false;
    document.removeEventListener('touchmove', blockScroll);
  };

  // Réponse du serveur à notre dépôt.
  useEffect(
    () =>
      connection.onMoveResult((res) => {
        if (res.requestId !== pending.current) return;
        pending.current = null;
        if (pendingTimer.current) clearTimeout(pendingTimer.current);
        if (res.ok) {
          setGhost(null);
        } else {
          if (dropFrom.current) returnGhost(dropFrom.current);
          onRefused(res.text ?? 'Déplacement refusé.');
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- returnGhost ne dépend que de refs
    [onRefused],
  );

  useEffect(
    () => () => {
      endDrag();
      if (pendingTimer.current) clearTimeout(pendingTimer.current);
    },
    [],
  );

  const onPointerDown = (
    e: ReactPointerEvent<HTMLElement>,
    from: SlotRef,
    itemId: string,
    qty: number,
  ) => {
    if (pending.current !== null || e.button > 0) return;
    const target = e.currentTarget;
    const id = e.pointerId;
    const timer = setTimeout(() => {
      const p = press.current;
      if (!p || p.id !== id) return;
      // Début du glisser : capture du pointeur, fantôme, défilement bloqué, petite vibration.
      dragging.current = true;
      try {
        p.target.setPointerCapture(id);
      } catch {
        // le pointeur a pu disparaître entre-temps
      }
      document.addEventListener('touchmove', blockScroll, { passive: false });
      navigator.vibrate?.(10);
      setGhost({ itemId: p.itemId, qty: p.qty, from: p.from, returning: false });
      requestAnimationFrame(() => placeGhost(p.x, p.y));
    }, longPressMs);
    press.current = { id, x: e.clientX, y: e.clientY, from, itemId, qty, target, timer };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    if (!dragging.current) {
      // Trop de mouvement avant la fin de l'appui long : c'est un défilement, pas un glisser.
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > dragCancelPx) {
        clearTimeout(p.timer);
        press.current = null;
      }
      return;
    }
    p.x = e.clientX;
    p.y = e.clientY;
    placeGhost(e.clientX, e.clientY);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    clearTimeout(p.timer);
    press.current = null;
    if (!dragging.current) return; // appui court : le clic fera la sélection
    endDrag();
    swallowClick.current = true;
    const to = slotAt(e.clientX, e.clientY);
    if (!to || (to.inv === p.from.inv && to.slot === p.from.slot)) {
      returnGhost(p.from); // lâché hors grille ou sur place : annulation
      return;
    }
    const msg: InventoryMoveMessage = {
      requestId: requestId.current++,
      from: p.from,
      to,
      itemId: p.itemId,
    };
    pending.current = msg.requestId;
    dropFrom.current = p.from;
    room.send(ClientMsg.InventoryMove, msg);
    const from = p.from;
    pendingTimer.current = setTimeout(() => {
      if (pending.current !== msg.requestId) return;
      pending.current = null;
      returnGhost(from);
    }, moveTimeoutMs);
  };

  const onPointerCancel = (e: ReactPointerEvent<HTMLElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    clearTimeout(p.timer);
    press.current = null;
    if (dragging.current) {
      endDrag();
      returnGhost(p.from);
    }
  };

  /** À appeler dans le onClick d'une case : faux si ce clic termine un glisser. */
  const consumeClick = () => {
    if (!swallowClick.current) return true;
    swallowClick.current = false;
    return false;
  };

  const def = ghost ? gameData.items.get(ghost.itemId) : undefined;
  const ghostNode = ghost ? (
    <div
      ref={ghostEl}
      className={`inv-ghost${ghost.returning ? ' returning' : ''}`}
      style={{ transitionDuration: ghost.returning ? `${RETURN_MS}ms` : '0ms' }}
    >
      <span className="inv-icon">{def?.icon}</span>
      <span className="inv-qty">{ghost.qty}</span>
    </div>
  ) : null;

  return {
    ghostNode,
    draggingFrom: ghost?.from ?? null,
    slotHandlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
    consumeClick,
  };
}
