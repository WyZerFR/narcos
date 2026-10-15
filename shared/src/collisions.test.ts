import { describe, expect, it } from 'vitest';
import { ejectToFree, findSlits, isBlocked, moveWithCollisions, settle } from './collision';
import { auditOptions, auditZone, auditZones } from './collisionAudit';
import { gameData } from './data';
import { rectFromCenter, type Rect, type Vec2 } from './geometry';
import { freshBudget, validateMove, type MoveRules } from './movement';
import { checkPlacement } from './placement';

const { config } = gameData;
const R = config.world.playerRadius;
const SUB = config.collision.maxSubStep;
const MIN_GAP = 2 * R + config.collision.passageMargin;
const ROOM: Rect = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };
const wall = (x: number, z: number, w: number, d: number) => rectFromCenter({ x, z }, { w, d });
const move = (from: Vec2, to: Vec2, rects: Rect[]) =>
  moveWithCollisions(from, to, R, rects, ROOM, SUB);
/** Pas d'une image en course (60 images/s). */
const STEP = config.movement.runSpeed / 60;

describe('collisions : glissement, coins, tunnel, éjection, passages', () => {
  it('glissement diagonal le long d’un mur : la vitesse sur l’axe libre est conservée', () => {
    const floor = [wall(0, 1, 20, 1)]; // mur horizontal, face nord en z = 0.5
    let p: Vec2 = { x: 0, z: 0.5 - R };
    const d = STEP * Math.SQRT1_2;
    for (let i = 0; i < 30; i++) p = move(p, { x: p.x + d, z: p.z + d }, floor);
    expect(p.x).toBeCloseTo(30 * d, 6); // aucune perte le long du mur
    expect(p.z).toBeCloseTo(0.5 - R, 6); // jamais dans le mur
  });

  it('coin intérieur : arrêt net dans l’angle, sans pénétrer ni trembler', () => {
    const corner = [wall(0, 1, 20, 1), wall(1, 0, 1, 20)]; // angle en (0.5, 0.5)
    let p: Vec2 = { x: -2, z: -2 };
    for (let i = 0; i < 60; i++) p = move(p, { x: p.x + STEP, z: p.z + STEP }, corner);
    expect(isBlocked(p, R, corner)).toBe(false);
    expect(p.x).toBeCloseTo(0.5 - R, 6);
    expect(p.z).toBeCloseTo(0.5 - R, 6);
    const again = move(p, { x: p.x + STEP, z: p.z + STEP }, corner);
    expect(Math.hypot(again.x - p.x, again.z - p.z)).toBeLessThan(1e-6);
  });

  it('coin extérieur pris de face : on glisse autour au lieu de rester accroché', () => {
    const box = [wall(0, 0, 2, 2)]; // coin en (1, 1)
    const start = { x: 1 + R * 0.6, z: 1 + R * 0.9 };
    const d = STEP * Math.SQRT1_2;
    const next = move(start, { x: start.x - d, z: start.z - d }, box);
    expect(isBlocked(next, R, box)).toBe(false);
    expect(Math.hypot(next.x - start.x, next.z - start.z)).toBeGreaterThan(0.5 * d);
  });

  it('pas de tunnel en course à travers un mur de 0,2 m (image par image et rafale serveur)', () => {
    const thin = [wall(0, 0, 0.2, 20)];
    let p: Vec2 = { x: -2, z: 0 };
    for (let i = 0; i < 60; i++) p = move(p, { x: p.x + STEP, z: p.z }, thin);
    expect(p.x).toBeLessThanOrEqual(-0.1 - R + 1e-9);
    const burst = move({ x: -2, z: 0 }, { x: 4, z: 0 }, thin);
    expect(burst.x).toBeLessThanOrEqual(-0.1 - R + 1e-9);
  });

  it('éjection : un joueur dans un obstacle ressort au point libre le plus proche', () => {
    const box = [wall(0, 0, 2, 2)];
    const inside = { x: 0.8, z: 0 };
    const out = settle(inside, R, box, ROOM, { x: 9, z: 9 });
    expect(isBlocked(out, R, box)).toBe(false);
    expect(Math.hypot(out.x - inside.x, out.z - inside.z)).toBeLessThan(1);
    // fente plus étroite que le joueur entre deux blocs : éjection hors de la fente
    const slit = [wall(-1, 0, 2, 2), wall(1.5, 0, 2, 2)];
    const ejected = ejectToFree({ x: 0.25, z: 0 }, R, slit, ROOM, 2); // sortie par le bout de la fente
    expect(ejected).not.toBeNull();
    expect(isBlocked(ejected!, R, slit)).toBe(false);
  });

  it('passage de largeur diamètre + marge : praticable ; plus étroit : signalé comme fente', () => {
    const gate = (gap: number) => [wall(-1 - gap / 2, 0, 2, 1), wall(1 + gap / 2, 0, 2, 1)];
    let p: Vec2 = { x: 0, z: -2 };
    for (let i = 0; i < 40; i++) p = move(p, { x: p.x, z: p.z + STEP }, gate(MIN_GAP));
    expect(p.z).toBeGreaterThan(1);
    expect(findSlits(gate(MIN_GAP), MIN_GAP)).toHaveLength(0);
    expect(findSlits(gate(MIN_GAP - 0.2), MIN_GAP)).toHaveLength(1);
    expect(findSlits(gate(0), MIN_GAP)).toHaveLength(0); // collés : pas de fente
  });
});

describe('collisions : client et serveur', () => {
  it('même fonction, mêmes paramètres : la prédiction du client est acceptée telle quelle', () => {
    const rects = [wall(0, 0, 4, 1), wall(3, 3, 1, 4), wall(-3, 2, 2, 2)];
    const rules: MoveRules = {
      maxSpeed: config.movement.runSpeed,
      toleranceFactor: config.movement.toleranceFactor,
      maxBurstMs: config.movement.maxBurstMs,
      bounds: ROOM,
      collision: {
        radius: R,
        obstacles: rects,
        correctionThreshold: config.collision.correctionThreshold,
        maxSubStep: SUB,
      },
    };
    const frames = Math.round(60 / config.movement.clientSendRateHz);
    let seed = 5;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let i = 0; i < 300; i++) {
      const start = { x: -5 + rand() * 10, z: -5 + rand() * 10 };
      if (isBlocked(start, R, rects)) continue;
      const a = rand() * Math.PI * 2;
      let client = start;
      for (let f = 0; f < frames; f++)
        client = move(
          client,
          { x: client.x + Math.cos(a) * STEP, z: client.z + Math.sin(a) * STEP },
          rects,
        );
      const v = validateMove(start, client, freshBudget(0, rules), (frames / 60) * 1000, rules);
      expect(v.corrected).toBe(false);
      expect(v.pos).toEqual(client);
    }
  });
});

describe('audit des collisions (version courte)', () => {
  const opts = auditOptions(gameData, 250, 11);
  for (const zone of auditZones(gameData))
    it(`${zone.id} : aucun cas problématique`, () => {
      const c = auditZone(zone, opts);
      expect(c.samples).toBeGreaterThan(50);
      const counts: Partial<typeof c> = { ...c };
      delete counts.samples;
      expect(counts).toEqual({
        stuck: 0,
        slideLoss: 0,
        tunnel: 0,
        entryBlocked: 0,
        falseCorrection: 0,
        insideAfterValidate: 0,
        narrowGaps: 0,
        furnitureTrap: 0,
      });
    });
});

describe('placement : écarts et porte', () => {
  const lab = gameData.interiors.get('lab')!;
  const check = (x: number, z: number) =>
    checkPlacement(
      gameData,
      { interior: lab, fixtures: [], players: [] },
      { itemId: 'pot', x, z, rot: 0 },
    );

  it('fente avec un mur refusée ; collé au mur ou à plus d’un passage : accepté', () => {
    // pot de 1,2 m, mur nord en z = -5
    expect(check(0, -4.2)).toMatchObject({ ok: false, reason: 'gap' });
    expect(check(0, -4.4).ok).toBe(true);
    expect(check(0, -3.2).ok).toBe(true);
  });
});
