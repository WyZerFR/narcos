import { input } from './inputState';

/**
 * Clavier : on lit `event.code` (position physique de la touche), donc WASD sur QWERTY
 * correspond automatiquement à ZQSD sur AZERTY. Flèches aussi. Maj = courir, E/Espace = action.
 */
const MOVE_KEYS: Record<string, 'up' | 'down' | 'left' | 'right'> = {
  KeyW: 'up',
  ArrowUp: 'up',
  KeyS: 'down',
  ArrowDown: 'down',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
};

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

export function bindKeyboard(): () => void {
  const onKey = (down: boolean) => (e: KeyboardEvent) => {
    if (isTyping(e.target)) return;
    const dir = MOVE_KEYS[e.code];
    if (dir) {
      input[dir] = down;
      e.preventDefault();
    } else if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      input.run = down;
    } else if (down && !e.repeat && (e.code === 'KeyE' || e.code === 'Space')) {
      input.actionPresses++;
      e.preventDefault();
    }
  };
  const onDown = onKey(true);
  const onUp = onKey(false);
  const reset = () => {
    input.up = input.down = input.left = input.right = input.run = false;
  };

  window.addEventListener('keydown', onDown);
  window.addEventListener('keyup', onUp);
  window.addEventListener('blur', reset);
  return () => {
    window.removeEventListener('keydown', onDown);
    window.removeEventListener('keyup', onUp);
    window.removeEventListener('blur', reset);
  };
}
