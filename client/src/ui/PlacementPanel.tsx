import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { gameData } from '@narco/shared';
import type { GameRoom } from '../net/connection';
import {
  cancelPlacement,
  checkCurrent,
  confirmPlacement,
  getPlacement,
  livePosition,
  nudge,
  rotatePlacement,
  usePlacement,
} from './placementStore';

const { repeatDelayMs, repeatMs } = gameData.config.placement;
/** Revalidation affichée (les autres joueurs bougent). */
const CHECK_MS = 150;

/** Flèches à l'écran : direction écran (x = droite, y = haut), relative à la caméra. */
const ARROWS = [
  { key: 'up', label: '▲', x: 0, y: 1, area: 'up' },
  { key: 'left', label: '◀', x: -1, y: 0, area: 'left' },
  { key: 'right', label: '▶', x: 1, y: 0, area: 'right' },
  { key: 'down', label: '▼', x: 0, y: -1, area: 'down' },
] as const;

const KEY_DIRS: Record<string, [number, number]> = {
  ArrowUp: [0, 1],
  KeyW: [0, 1],
  ArrowDown: [0, -1],
  KeyS: [0, -1],
  ArrowLeft: [-1, 0],
  KeyA: [-1, 0],
  ArrowRight: [1, 0],
  KeyD: [1, 0],
};

/** Bouton qui répète son action tant qu'on le tient (Pointer Events, sans hover). */
function HoldButton({ label, area, onStep }: { label: string; area: string; onStep: () => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const start = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    stop();
    onStep();
    const repeat = () => {
      onStep();
      timer.current = setTimeout(repeat, repeatMs);
    };
    timer.current = setTimeout(repeat, repeatDelayMs);
  };
  useEffect(() => stop, []);
  return (
    <button
      type="button"
      className="place-arrow"
      style={{ gridArea: area }}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
    </button>
  );
}

/**
 * Commandes du mode placement : flèches (bas gauche, à la place du joystick), Pivoter /
 * Annuler / Valider (bas droite, à la place d'ACTION), état en haut. La caméra centre le
 * fantôme : rien ne le recouvre. Clavier : flèches / ZQSD, R pivote, Entrée valide, Échap annule.
 */
export function PlacementPanel({ room }: { room: GameRoom }) {
  const placement = usePlacement();
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), CHECK_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const pl = getPlacement();
      if (!pl || pl.direct) return;
      const dir = KEY_DIRS[e.code];
      if (dir) nudge(dir[0], dir[1]);
      else if (e.code === 'KeyR') rotatePlacement();
      else if (e.code === 'Enter') confirmPlacement(room);
      else if (e.code === 'Escape') cancelPlacement();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [room]);

  // glisser direct : pas de panneau, le fantôme rouge / vert suffit
  if (!placement || placement.direct) return null;
  const live = livePosition(placement);
  const check = checkCurrent(room, { ...placement, ...live });
  const valid = check?.ok ?? false;
  const name = gameData.items.get(placement.itemId)?.name ?? placement.itemId;
  const message = placement.pending
    ? 'Envoi…'
    : (placement.error ?? (check && !check.ok ? check.message : 'Emplacement libre'));

  return (
    <>
      <div className={`place-status${valid && !placement.error ? '' : ' bad'}`}>
        <strong>
          {placement.mode === 'move' ? 'Déplacer' : 'Placer'} : {name}
        </strong>
        <span>{message}</span>
      </div>
      <div className="place-arrows">
        {ARROWS.map((a) => (
          <HoldButton key={a.key} label={a.label} area={a.area} onStep={() => nudge(a.x, a.y)} />
        ))}
      </div>
      <div className="place-actions">
        <button type="button" className="btn" onClick={rotatePlacement}>
          ⟳ Pivoter
        </button>
        <button type="button" className="btn" onClick={cancelPlacement}>
          Annuler
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!valid || placement.pending !== null}
          onClick={() => confirmPlacement(room)}
        >
          Valider
        </button>
      </div>
    </>
  );
}
