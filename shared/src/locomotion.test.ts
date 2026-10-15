import { describe, expect, it } from 'vitest';
import { gameData } from './data';
import {
  gaitTimeScale,
  Locomotion,
  nextGait,
  stepWeights,
  turnToward,
  type Gait,
  type GaitWeights,
} from './locomotion';

const r = gameData.config.characters.locomotion;
const ALL = { walk: true, run: true };

/** Joueur qui avance à `speed` m/s le long de x pendant `seconds`, à `fps`. */
function run(loco: Locomotion, speed: number, seconds: number, fps: number, heading = 0) {
  const dt = 1 / fps;
  const start = (loco as unknown as { last: { x: number } | null }).last?.x ?? 0;
  let x = start;
  for (let i = 0; i < Math.round(seconds * fps); i++) {
    x += speed * dt;
    loco.step(x, 0, heading, dt);
  }
}

describe('allure selon la vitesse', () => {
  it('arrêt, marche, course', () => {
    expect(nextGait('idle', 0, r, ALL)).toBe('idle');
    expect(nextGait('idle', 2, r, ALL)).toBe('walk');
    expect(nextGait('idle', 7, r, ALL)).toBe('run');
    expect(nextGait('walk', 7, r, ALL)).toBe('run');
    expect(nextGait('run', 0.1, r, ALL)).toBe('idle');
  });

  it('hystérésis : pas de clignotement entre deux seuils', () => {
    const between = (r.walkStop + r.walkStart) / 2;
    expect(nextGait('idle', between, r, ALL)).toBe('idle');
    expect(nextGait('walk', between, r, ALL)).toBe('walk');
    const fast = (r.runStop + r.runStart) / 2;
    expect(nextGait('walk', fast, r, ALL)).toBe('walk');
    expect(nextGait('run', fast, r, ALL)).toBe('run');
    // vitesse qui oscille autour du seuil de départ : une seule bascule
    let g: Gait = 'idle';
    const seen: Gait[] = [];
    for (let i = 0; i < 40; i++) {
      g = nextGait(g, r.walkStart + (i % 2 ? 0.05 : -0.1), r, ALL);
      if (seen.at(-1) !== g) seen.push(g);
    }
    expect(seen).toEqual(['idle', 'walk']);
  });

  it('sans clip de course, la marche couvre toutes les vitesses', () => {
    expect(nextGait('walk', 9, r, { walk: true, run: false })).toBe('walk');
  });
});

describe('timeScale', () => {
  it('proportionnel à la vitesse réelle, borné', () => {
    expect(gaitTimeScale('walk', r.walkClipSpeed, r)).toBeCloseTo(1);
    const a = gaitTimeScale('walk', r.walkClipSpeed * 0.8, r);
    const b = gaitTimeScale('walk', r.walkClipSpeed * 1.2, r);
    expect(b / a).toBeCloseTo(1.5);
    expect(gaitTimeScale('run', r.runClipSpeed * 1.1, r)).toBeCloseTo(1.1);
    expect(gaitTimeScale('walk', 100, r)).toBe(r.timeScale.max);
    expect(gaitTimeScale('walk', 0.01, r)).toBe(r.timeScale.min);
    expect(gaitTimeScale('idle', 3, r)).toBe(1);
  });
});

describe('fondu enchaîné', () => {
  const sum = (w: GaitWeights) => w.idle + w.walk + w.run;

  it('continu, durée crossFadeSeconds, somme des poids = 1', () => {
    let w: GaitWeights = { idle: 1, walk: 0, run: 0 };
    const dt = 1 / 60;
    let frames = 0;
    while (w.walk < 1) {
      const next = stepWeights(w, 'walk', dt, r.crossFadeSeconds);
      expect(Math.abs(next.walk - w.walk)).toBeLessThanOrEqual(dt / r.crossFadeSeconds + 1e-9);
      expect(sum(next)).toBeCloseTo(1);
      w = next;
      frames++;
    }
    expect(frames).toBe(Math.ceil(r.crossFadeSeconds / dt - 1e-9));
  });

  it('cible changée en plein fondu : repart des poids courants, sans saut', () => {
    let w: GaitWeights = { idle: 1, walk: 0, run: 0 };
    const dt = 1 / 60;
    for (let i = 0; i < 5; i++) w = stepWeights(w, 'walk', dt, r.crossFadeSeconds);
    const mid = { ...w };
    const next = stepWeights(w, 'run', dt, r.crossFadeSeconds);
    for (const g of ['idle', 'walk', 'run'] as const)
      expect(Math.abs(next[g] - mid[g])).toBeLessThan(2 * (dt / r.crossFadeSeconds));
  });

  it('dans la plage demandée (0,15 à 0,25 s)', () => {
    expect(r.crossFadeSeconds).toBeGreaterThanOrEqual(0.15);
    expect(r.crossFadeSeconds).toBeLessThanOrEqual(0.25);
  });
});

describe('rotation du corps', () => {
  it('chemin le plus court (passage par ±π)', () => {
    const a = turnToward(3, -3, 1 / 60, r.turnStiffness);
    expect(a).toBeGreaterThan(3); // tourne vers +π, pas en repassant par 0
    let h = 3;
    for (let i = 0; i < 120; i++) h = turnToward(h, -3, 1 / 60, r.turnStiffness);
    expect(Math.cos(h - -3)).toBeCloseTo(1, 3);
  });

  it('pas de rotation à l’arrêt', () => {
    const loco = new Locomotion(r, 0);
    for (let i = 0; i < 60; i++) loco.step(0, 0, Math.PI / 2, 1 / 60);
    expect(loco.heading).toBe(0);
    run(loco, 3, 1, 60, Math.PI / 2);
    expect(loco.heading).toBeCloseTo(Math.PI / 2, 2);
  });

  it('penchement avant proportionnel à la vitesse, plafonné', () => {
    const slow = new Locomotion(r);
    run(slow, 2, 2, 60);
    const fast = new Locomotion(r);
    run(fast, 7, 2, 60);
    expect(slow.lean).toBeGreaterThan(0);
    expect(fast.lean).toBeGreaterThan(slow.lean);
    expect(fast.lean).toBeLessThanOrEqual(r.lean.max + 1e-9);
  });
});

describe('même résultat à 30 et 60 fps', () => {
  it('vitesse, allure, poids, cap, penchement', () => {
    const a = new Locomotion(r);
    const b = new Locomotion(r);
    for (const [speed, secs, heading] of [
      [0, 0.5, 0],
      [2.5, 1, 1],
      [7, 1, -2.5],
      [0, 1, 2],
    ] as const) {
      run(a, speed, secs, 30, heading);
      run(b, speed, secs, 60, heading);
      expect(a.gait).toBe(b.gait);
      expect(a.speed).toBeCloseTo(b.speed, 1);
      expect(a.heading).toBeCloseTo(b.heading, 2);
      expect(a.lean).toBeCloseTo(b.lean, 2);
      for (const g of ['idle', 'walk', 'run'] as const)
        expect(a.weights[g]).toBeCloseTo(b.weights[g], 2);
    }
  });

  it('téléportation ignorée ; rebond de repli seulement sans clip de marche', () => {
    const loco = new Locomotion(r);
    loco.step(0, 0, 0, 1 / 60);
    loco.step(50, 0, 0, 1 / 60);
    expect(loco.speed).toBe(0);
    const noClip = new Locomotion(r);
    noClip.clips = { walk: false, run: false };
    run(noClip, 2, 0.4, 60);
    expect(noClip.gait).toBe('walk');
    const offsets = new Set<number>();
    for (let i = 0; i < 20; i++) {
      run(noClip, 2, 1 / 60, 60);
      offsets.add(Math.round(noClip.bobOffset() * 1000));
    }
    expect(Math.max(...offsets) / 1000).toBeLessThanOrEqual(r.bob.height);
    expect(offsets.size).toBeGreaterThan(3);
    const withClip = new Locomotion(r);
    run(withClip, 2, 1, 60);
    expect(withClip.bobOffset()).toBe(0);
  });
});
