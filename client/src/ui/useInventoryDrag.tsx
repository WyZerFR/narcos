import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  bagSignature,
  ClientMsg,
  gameData,
  predictedBag,
  pruneMoves,
  settleMove,
  type Inventory,
  type InventoryKind,
  type InventoryMoveMessage,
  type PredictedMove,
} from '@narco/shared';
import { connection, type GameRoom } from '../net/connection';

const { longPressMs, dragCancelPx, moveTimeoutMs } = gameData.config.ui;
/** Durée du retour du fantôme vers son slot après un refus ou une annulation (style). */
const RETURN_MS = 220;
/** Durée de la pose du fantôme dans le slot cible (style). */
const LAND_MS = 150;
/** Objet soulevé : léger agrandissement (style). */
const LIFT_SCALE = 1.12;
/** Part du trajet vers la case de départ que fait l'objet qui s'écarte (aperçu d'échange). */
const SWAP_PREVIEW = 0.55;

export interface SlotRef {
  inv: InventoryKind;
  slot: number;
}

interface Ghost {
  itemId: string;
  qty: number;
  from: SlotRef;
  /** drag : suit le doigt ; landing : se pose dans la case cible ; returning : retour. */
  phase: 'drag' | 'landing' | 'returning';
  /** Case masquée pendant le trajet du fantôme (l'objet y arrive). */
  hiddenSlot: number | null;
}

/** Slot sous un point de l'écran (les cases portent `data-inv` et `data-slot`). */
function slotAt(x: number, y: number): SlotRef | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-inv][data-slot]');
  if (!el) return null;
  return { inv: el.dataset.inv as InventoryKind, slot: Number(el.dataset.slot) };
}

function slotEl(ref: SlotRef): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-inv="${ref.inv}"][data-slot="${ref.slot}"]`);
}

function slotRect(ref: SlotRef): DOMRect | null {
  return slotEl(ref)?.getBoundingClientRect() ?? null;
}

const centerOf = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
const sameSlot = (a: SlotRef, b: SlotRef) => a.inv === b.inv && a.slot === b.slot;

/** Bloque le défilement iOS pendant un glisser (écouteur non passif). */
const blockScroll = (e: TouchEvent) => e.preventDefault();

/**
 * Glisser-déposer par appui long, sans dépendance : Pointer Events + `setPointerCapture`.
 * - appui court : rien ici, le clic garde son rôle (sélection) ;
 * - mouvement > `dragCancelPx` avant `longPressMs` : appui annulé, la grille défile ;
 * - appui long : l'objet se soulève (agrandi, ombre, vibration) et suit le doigt par transform,
 *   sans re-rendu React ; la case visée est surlignée et l'objet qui s'y trouve s'écarte vers
 *   la case de départ (aperçu d'échange) ;
 * - lâcher sur un slot : pose animée, déplacement prédit tout de suite (`predictedBag`), message
 *   `inventory.move` ; refus (ou pas de réponse en `moveTimeoutMs`) → rollback et retour animé ;
 * - lâcher hors grille : retour animé à la case d'origine.
 * `serverBag` lit le sac de l'état serveur ; `view()` renvoie le sac à afficher (prédit).
 */
export function useInventoryDrag(
  room: GameRoom,
  onRefused: (text: string) => void,
  serverBag: () => Inventory,
) {
  const [ghost, setGhost] = useState<Ghost | null>(null);
  /** Coups en attente de confirmation (prédiction) ; `bump` re-rend quand la liste change. */
  const moves = useRef<PredictedMove[]>([]);
  const [, setMovesVersion] = useState(0);
  const bump = () => setMovesVersion((v) => v + 1);
  /** Dernier sac affiché (pour savoir ce qu'il y a sous le doigt). */
  const shown = useRef<Inventory>([]);
  /** Case survolée pendant le glisser (classes posées directement sur le DOM). */
  const hover = useRef<HTMLElement | null>(null);
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
  /** Dernier dépôt envoyé : origine et cible (pour le retour animé en cas de refus). */
  const dropFrom = useRef<SlotRef | null>(null);
  const dropTo = useRef<SlotRef | null>(null);
  const requestId = useRef(1);

  /** Position du fantôme (transform seulement : aucun re-rendu React pendant le glisser). */
  const placeGhost = (x: number, y: number, scale: number, ms = 0) => {
    const el = ghostEl.current;
    if (!el) return;
    el.style.transitionDuration = `${ms}ms`;
    el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${scale})`;
  };

  /** Surligne la case visée ; l'objet qui l'occupe s'écarte vers la case de départ. */
  const setHover = (to: SlotRef | null, from: SlotRef | null, itemId: string) => {
    const el = to && from && !sameSlot(to, from) ? slotEl(to) : null;
    if (el === hover.current) return;
    const prev = hover.current;
    if (prev) {
      prev.classList.remove('drop-target', 'drop-merge', 'drop-swap');
      const content = prev.querySelector<HTMLElement>('.inv-content');
      if (content) content.style.transform = '';
    }
    hover.current = el;
    if (!el || !to || !from) return;
    const there = shown.current[to.slot];
    el.classList.add('drop-target');
    if (!there) return;
    if (there.itemId === itemId) {
      el.classList.add('drop-merge');
      return;
    }
    el.classList.add('drop-swap');
    const a = slotRect(to);
    const b = slotRect(from);
    const content = el.querySelector<HTMLElement>('.inv-content');
    if (a && b && content) {
      const dx = (b.left - a.left) * SWAP_PREVIEW;
      const dy = (b.top - a.top) * SWAP_PREVIEW;
      content.style.transform = `translate(${dx}px, ${dy}px)`;
    }
  };

  /** Pose animée : le fantôme rejoint la case cible, où l'objet (prédit) apparaît ensuite. */
  const landGhost = (to: SlotRef) => {
    const r = slotRect(to);
    setGhost((g) => (g ? { ...g, phase: 'landing', hiddenSlot: to.slot } : g));
    if (r) placeGhost(centerOf(r).x, centerOf(r).y, 1, LAND_MS);
    setTimeout(() => setGhost((g) => (g?.phase === 'landing' ? null : g)), LAND_MS);
  };

  /**
   * Retour animé vers la case d'origine : depuis la position actuelle du fantôme, ou depuis la
   * case `startAt` (refus serveur après la pose : l'objet repart de là où on l'avait posé).
   */
  const returnGhost = (
    from: SlotRef,
    startAt?: SlotRef,
    item?: { itemId: string; qty: number },
  ) => {
    const end = slotRect(from);
    const start = startAt ? slotRect(startAt) : null;
    setGhost((g) => {
      const base = g ?? (item ? { ...item, from } : null);
      return base ? { ...base, from, phase: 'returning', hiddenSlot: from.slot } : null;
    });
    requestAnimationFrame(() => {
      if (start) placeGhost(centerOf(start).x, centerOf(start).y, 1);
      ghostEl.current?.getBoundingClientRect(); // fige la position de départ avant la transition
      if (end) placeGhost(centerOf(end).x, centerOf(end).y, 1, RETURN_MS);
    });
    setTimeout(() => setGhost((g) => (g?.phase === 'returning' ? null : g)), RETURN_MS);
  };

  /** Refus ou absence de réponse : rollback de la prédiction et retour animé. */
  const rollback = (id: number, text: string | null) => {
    const m = moves.current.find((x) => x.requestId === id);
    moves.current = settleMove(moves.current, id, false);
    bump();
    if (dropFrom.current && m)
      returnGhost(dropFrom.current, dropTo.current ?? undefined, {
        itemId: m.itemId,
        qty: serverBag()[m.fromSlot]?.qty ?? 1,
      });
    if (text) onRefused(text);
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
          moves.current = settleMove(moves.current, res.requestId, true);
          bump();
        } else rollback(res.requestId, res.text ?? 'Déplacement refusé.');
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rollback ne dépend que de refs
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
      setGhost({ itemId: p.itemId, qty: p.qty, from: p.from, phase: 'drag', hiddenSlot: null });
      requestAnimationFrame(() => placeGhost(p.x, p.y, LIFT_SCALE));
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
    placeGhost(e.clientX, e.clientY, LIFT_SCALE);
    setHover(slotAt(e.clientX, e.clientY), p.from, p.itemId);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    clearTimeout(p.timer);
    press.current = null;
    if (!dragging.current) return; // appui court : le clic fera la sélection
    endDrag();
    setHover(null, null, '');
    swallowClick.current = true;
    const to = slotAt(e.clientX, e.clientY);
    if (!to || sameSlot(to, p.from)) {
      returnGhost(p.from); // lâché hors grille ou sur place : annulation
      return;
    }
    const msg: InventoryMoveMessage = {
      requestId: requestId.current++,
      from: p.from,
      to,
      itemId: p.itemId,
    };
    // Prédiction : le sac affiché change tout de suite, le serveur confirme ou annule.
    moves.current = [
      ...moves.current,
      {
        requestId: msg.requestId,
        fromSlot: p.from.slot,
        toSlot: to.slot,
        itemId: p.itemId,
        base: bagSignature(serverBag()),
        confirmed: false,
      },
    ];
    bump();
    landGhost(to);
    pending.current = msg.requestId;
    dropFrom.current = p.from;
    dropTo.current = to;
    room.send(ClientMsg.InventoryMove, msg);
    pendingTimer.current = setTimeout(() => {
      if (pending.current !== msg.requestId) return;
      pending.current = null;
      rollback(msg.requestId, 'Pas de réponse du serveur.');
    }, moveTimeoutMs);
  };

  const onPointerCancel = (e: ReactPointerEvent<HTMLElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    clearTimeout(p.timer);
    press.current = null;
    if (dragging.current) {
      endDrag();
      setHover(null, null, '');
      returnGhost(p.from);
    }
  };

  /** À appeler dans le onClick d'une case : faux si ce clic termine un glisser. */
  const consumeClick = () => {
    if (!swallowClick.current) return true;
    swallowClick.current = false;
    return false;
  };

  /** Sac à afficher : état serveur + coups prédits (les coups appliqués par le serveur sortent). */
  const view = (server: Inventory): Inventory => {
    moves.current = pruneMoves(server, moves.current);
    shown.current = predictedBag(server, moves.current, gameData.items);
    return shown.current;
  };

  const def = ghost ? gameData.items.get(ghost.itemId) : undefined;
  const ghostNode = ghost ? (
    <div ref={ghostEl} className={`inv-ghost ${ghost.phase}`}>
      <span className="inv-icon">{def?.icon}</span>
      <span className="inv-qty">{ghost.qty}</span>
    </div>
  ) : null;

  return {
    ghostNode,
    draggingFrom: ghost?.phase === 'drag' ? ghost.from : null,
    hiddenSlot: ghost?.hiddenSlot ?? null,
    view,
    slotHandlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
    consumeClick,
  };
}
