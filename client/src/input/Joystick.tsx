import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { input } from './inputState';

const RADIUS = 60; // px, course max du stick

type Point = { x: number; y: number };

/**
 * Joystick virtuel flottant : il apparaît là où le pouce touche la moitié gauche de l'écran.
 * Pointer events + capture (multi-touch : le bouton d'action reste utilisable en même temps).
 */
export function Joystick() {
  const pointerId = useRef<number | null>(null);
  const [origin, setOrigin] = useState<Point | null>(null);
  const [knob, setKnob] = useState<Point>({ x: 0, y: 0 });

  const release = () => {
    pointerId.current = null;
    input.joyX = input.joyY = 0;
    setOrigin(null);
    setKnob({ x: 0, y: 0 });
  };

  useEffect(() => {
    const onBlur = () => {
      pointerId.current = null;
      input.joyX = input.joyY = 0;
      setOrigin(null);
      setKnob({ x: 0, y: 0 });
    };
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('blur', onBlur);
      onBlur();
    };
  }, []);

  const update = (cx: number, cy: number, o: Point) => {
    let dx = cx - o.x;
    let dy = cy - o.y;
    const len = Math.hypot(dx, dy);
    if (len > RADIUS) {
      dx = (dx / len) * RADIUS;
      dy = (dy / len) * RADIUS;
    }
    setKnob({ x: dx, y: dy });
    input.joyX = dx / RADIUS;
    input.joyY = -dy / RADIUS;
  };

  const onEnd = (e: PointerEvent) => {
    if (e.pointerId === pointerId.current) release();
  };

  return (
    <div
      className="joystick-zone"
      onPointerDown={(e) => {
        if (pointerId.current !== null) return;
        pointerId.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
        const o = { x: e.clientX, y: e.clientY };
        setOrigin(o);
        update(e.clientX, e.clientY, o);
      }}
      onPointerMove={(e) => {
        if (e.pointerId === pointerId.current && origin) update(e.clientX, e.clientY, origin);
      }}
      onPointerUp={onEnd}
      onPointerCancel={onEnd}
    >
      <div
        className={`joystick-base${origin ? ' active' : ''}`}
        style={origin ? { left: origin.x, top: origin.y } : undefined}
      >
        <div
          className="joystick-knob"
          style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }}
        />
      </div>
    </div>
  );
}
