import { useState } from 'react';
import { triggerAction } from './inputState';

/** Bouton d'action contextuel (droite) : libellé selon le lieu proche, grisé sinon. */
export function ActionButton({ label, active }: { label: string; active: boolean }) {
  const [pressed, setPressed] = useState(false);
  return (
    <button
      type="button"
      className={`action-button${pressed ? ' pressed' : ''}${active ? ' active' : ''}`}
      aria-disabled={!active}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        triggerAction();
        setPressed(true);
      }}
      onPointerUp={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
    >
      {label}
    </button>
  );
}
