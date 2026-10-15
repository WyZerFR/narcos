import { describe, expect, it } from 'vitest';
import { moveWithCollisions, isBlocked } from './collision';
import { gameData } from './data';
import { freshBudget, validateMove, type MoveRules } from './movement';
import { lerpAngle, Reconciler, smoothFactor, SnapshotBuffer, type Collider } from './smoothing';
import { STREET, zoneArea } from './zones';

const cfg = gameData.config;
const net = cfg.netSmoothing;
const R = cfg.world.playerRadius;
const reconcileRules = {
  ignoreDistance: net.correctionIgnoreDistance,
  snapDistance: net.correctionSnapDistance,
  blendStiffness: net.correctionBlendStiffness,
};
const empty: Collider = {
  radius: R,
  obstacles: [],
  bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
  maxSubStep: cfg.collision.maxSubStep,
};

/** Générateur pseudo-aléatoire déterministe. */
function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

describe('smoothFactor', () => {
  it('donne le même résultat à 30 et 60 fps', () => {
    const run = (fps: number) => {
      let x = 0;
      for (let i = 0; i < fps; i++)
        x += (10 - x) * smoothFactor(cfg.cameraRig.followStiffness, 1 / fps);
      return x;
    };
    expect(run(30)).toBeCloseTo(run(60), 9);
    // rotation : même chose
    const rot = (fps: number) => {
      let a = 0;
      for (let i = 0; i < fps / 2; i++)
        a = lerpAngle(a, 3, smoothFactor(net.rotationStiffness, 1 / fps));
      return a;
    };
    expect(rot(30)).toBeCloseTo(rot(60), 9);
  });

  it('tourne par le chemin le plus court', () => {
    expect(lerpAngle(3, -3, 0.5)).toBeCloseTo(Math.PI, 1);
  });
});

describe('SnapshotBuffer', () => {
  it('reste continu avec des paquets irréguliers (retard fixe, pas de saut)', () => {
    const rand = rng(3);
    const buf = new SnapshotBuffer(cfg.room.patchRateMs);
    const speed = 8 / 1000; // m/ms, en course
    let next = 0;
    let prevX: number | null = null;
    let maxStep = 0;
    for (let now = 0; now < 5000; now += 1000 / 60) {
      // paquets toutes les 50 ms ± gigue, parfois groupés après 150 ms de silence
      while (next <= now) {
        buf.push({ t: now, x: next * speed, z: 0, rotY: 0 });
        next += rand() < 0.1 ? 150 : 30 + rand() * 40;
      }
      const s = buf.sample(now - net.remoteDelayMs);
      if (!s) continue;
      if (prevX !== null) {
        expect(s.x).toBeGreaterThanOrEqual(prevX - 1e-9); // jamais de recul
        maxStep = Math.max(maxStep, s.x - prevX);
      }
      prevX = s.x;
    }
    // pas maximal d'une frame : bien moins qu'un paquet groupé de 150 ms (1,2 m)
    expect(maxStep).toBeLessThan(0.5);
  });

  it("repart d'un arrêt sans glisser depuis l'ancienne position", () => {
    const buf = new SnapshotBuffer(50);
    buf.push({ t: 0, x: 0, z: 0, rotY: 0 });
    buf.push({ t: 5000, x: 0.4, z: 0, rotY: 0 });
    // 100 ms avant le nouveau paquet, l'entité était encore immobile
    expect(buf.sample(4900)!.x).toBe(0);
    expect(buf.sample(4975)!.x).toBeCloseTo(0.2);
  });
});

describe('Reconciler', () => {
  it('une correction sous le seuil ne déplace pas le joueur', () => {
    const r = new Reconciler(reconcileRules);
    r.recordSent(1, { x: 0, z: 0 });
    const current = { x: 0.3, z: 0 };
    const res = r.correct(current, { x: net.correctionIgnoreDistance / 2, z: 0, seq: 1 }, empty);
    expect(res.kind).toBe('ignore');
    let p = res.pos;
    for (let i = 0; i < 60; i++) p = r.step(p, 1 / 60, empty);
    expect(p).toEqual(current);
  });

  it("garde le chemin fait depuis l'envoi et résorbe l'écart en fondu", () => {
    const r = new Reconciler(reconcileRules);
    r.recordSent(4, { x: 1, z: 0 });
    // le serveur a retenu 0,5 m plus court ; le client a avancé de 0,4 m depuis
    const res = r.correct({ x: 1.4, z: 0 }, { x: 0.5, z: 0, seq: 4 }, empty);
    expect(res.kind).toBe('blend');
    expect(res.pos.x).toBe(1.4); // pas de saut
    let p = res.pos;
    let prev = p.x;
    for (let i = 0; i < 60; i++) {
      p = r.step(p, 1 / 60, empty);
      expect(prev - p.x).toBeLessThan(0.15); // fondu sur plusieurs frames
      prev = p.x;
    }
    expect(p.x).toBeCloseTo(0.9, 3);
  });

  it('se recale d’un coup au-delà du second seuil', () => {
    const r = new Reconciler(reconcileRules);
    r.recordSent(2, { x: 0, z: 0 });
    const res = r.correct({ x: 0.2, z: 0 }, { x: 10, z: 0, seq: 2 }, empty);
    expect(res.kind).toBe('snap');
    expect(res.pos.x).toBeCloseTo(10.2);
  });
});

// ---------------------------------------------------------------- simulation complète

interface SimResult {
  corrections: number;
  oscillations: number;
  seconds: number;
}

/**
 * Client à pas de temps variable (60 fps avec images à 30 fps) qui pousse dans une direction
 * fixe, envois à `clientSendRateHz`, réseau ordonné avec gigue et paquets groupés, serveur
 * qui valide ; corrections renvoyées et traitées par le Reconciler.
 */
function simulate(
  zone: string,
  start: { x: number; z: number },
  dir: { x: number; z: number },
  run: boolean,
  rand: () => number,
): SimResult {
  const area = zoneArea(gameData, zone)!;
  const rules: MoveRules = {
    maxSpeed: cfg.movement.runSpeed,
    toleranceFactor: cfg.movement.toleranceFactor,
    maxBurstMs: cfg.movement.maxBurstMs,
    bounds: area.bounds,
    collision: {
      radius: R,
      obstacles: area.obstacles,
      correctionThreshold: cfg.collision.correctionThreshold,
      maxSubStep: cfg.collision.maxSubStep,
    },
  };
  const col: Collider = {
    radius: R,
    obstacles: area.obstacles,
    bounds: area.bounds,
    maxSubStep: cfg.collision.maxSubStep,
  };
  const rec = new Reconciler(reconcileRules);
  const speed = run ? cfg.movement.runSpeed : cfg.movement.walkSpeed;
  let client = { ...start };
  let server = { ...start };
  let budget = freshBudget(0, rules);
  const up: { at: number; x: number; z: number; seq: number }[] = [];
  const down: { at: number; x: number; z: number; seq: number }[] = [];
  let t = 0;
  let send = 0;
  let seq = 0;
  let corrections = 0;
  let oscillations = 0;
  let lastD = { x: 0, z: 0 };
  const seconds = 2.5;
  while (t < seconds) {
    const dt = rand() < 0.2 ? 1 / 30 : 1 / 60;
    t += dt;
    while (down[0] && down[0].at <= t) {
      const c = down.shift()!;
      corrections++;
      client = rec.correct(client, c, col).pos;
    }
    while (up[0] && up[0].at <= t) {
      const m = up.shift()!;
      const res = validateMove(server, m, budget, m.at * 1000, rules);
      budget = res.budget;
      server = res.pos;
      if (res.corrected) down.push({ at: t + 0.04, ...server, seq: m.seq });
    }
    const prev = client;
    client = moveWithCollisions(
      client,
      { x: client.x + dir.x * speed * dt, z: client.z + dir.z * speed * dt },
      R,
      area.obstacles,
      area.bounds,
      cfg.collision.maxSubStep,
    );
    client = rec.step(client, dt, col);
    const d = { x: client.x - prev.x, z: client.z - prev.z };
    // oscillation : le déplacement d'une frame repart en sens inverse de la précédente
    if (
      Math.hypot(d.x, d.z) > 1e-4 &&
      Math.hypot(lastD.x, lastD.z) > 1e-4 &&
      d.x * lastD.x + d.z * lastD.z < 0
    )
      oscillations++;
    lastD = d;
    send += dt;
    if (send >= 1 / cfg.movement.clientSendRateHz) {
      send = 0;
      seq++;
      rec.recordSent(seq, client);
      // réseau ordonné (WebSocket) : gigue, parfois 150 ms de retard qui groupe les paquets
      const lastAt = up[up.length - 1]?.at ?? 0;
      up.push({
        at: Math.max(lastAt, t + 0.03 + (rand() < 0.15 ? 0.15 : rand() * 0.03)),
        ...client,
        seq,
      });
    }
  }
  return { corrections, oscillations, seconds };
}

describe('poussée contre murs, comptoirs et coins (8 directions, marche et course)', () => {
  for (const zone of [STREET, ...gameData.interiors.keys()]) {
    it(`${zone} : ni oscillation ni correction`, () => {
      const area = zoneArea(gameData, zone)!;
      const b = area.bounds;
      const rand = rng(11);
      let tested = 0;
      let corrections = 0;
      let oscillations = 0;
      for (let i = 0; i < 400 && tested < (zone === STREET ? 12 : 8); i++) {
        const p = {
          x: b.minX + rand() * (b.maxX - b.minX),
          z: b.minZ + rand() * (b.maxZ - b.minZ),
        };
        if (isBlocked(p, R, area.obstacles)) continue;
        tested++;
        for (let k = 0; k < 8; k++)
          for (const run of [false, true]) {
            const a = (k / 8) * Math.PI * 2;
            const r = simulate(zone, p, { x: Math.cos(a), z: Math.sin(a) }, run, rand);
            corrections += r.corrections;
            oscillations += r.oscillations;
          }
      }
      expect(tested).toBeGreaterThan(0);
      expect(oscillations).toBe(0);
      expect(corrections).toBe(0);
    });
  }
});
