import { useState } from 'react';
import { input } from './inputState';

/** Bouton d'action contextuel (droite). Sans effet de gameplay pour l'instant. */
export function ActionButton({ label = 'ACTION' }: { label?: string }) {
  const [pressed, setPressed] = useState(false);
  return (
    <button
      type="button"
      className={`action-button${pressed ? ' pressed' : ''}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        input.actionPresses++;
        setPressed(true);
      }}
      onPointerUp={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
    >
      {label}
    </button>
  );
}
