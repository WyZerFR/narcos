import { describe, expect, it } from 'vitest';
import { isBlocked, moveWithCollisions } from './collision';
import { gameData } from './data';
import { interiorPlaces } from './fixtures';
import type { Vec2 } from './geometry';
import { freshBudget, validateMove, type MoveRules } from './movement';
import { inInteractRange, stickyNearest, zoneArea } from './zones';

/**
 * Comptoirs et rayons des magasins : complément de l'audit des collisions (collisionAudit.ts),
 * poussée dirigée contre chaque poste solide, et hystérésis du bouton ACTION.
 */

const { config } = gameData;
const R = config.world.playerRadius;
const SUB = config.collision.maxSubStep;
const EXIT = config.world.interactExitMargin;
const DT = 1 / 60;
const FRAMES_PER_SEND = Math.max(1, Math.round(60 / config.movement.clientSendRateHz));
const SHOPS = ['shop', 'grocery', 'bank'];
const DIRS = Array.from({ length: 8 }, (_, k) => ({
  x: Math.cos((k * Math.PI) / 4),
  z: Math.sin((k * Math.PI) / 4),
}));

/** Règles du serveur pour une zone (mêmes réglages que NarcoRoom). */
function rulesOf(zoneId: string): MoveRules {
  const area = zoneArea(gameData, zoneId)!;
  return {
    maxSpeed: config.movement.runSpeed,
    toleranceFactor: config.movement.toleranceFactor,
    maxBurstMs: config.movement.maxBurstMs,
    bounds: area.bounds,
    collision: {
      radius: R,
      obstacles: area.obstacles,
      correctionThreshold: config.collision.correctionThreshold,
      maxSubStep: SUB,
    },
  };
}

/** Pousse 3 s dans `dir` (prédiction client à 60 i/s, envoi au serveur comme le client). */
function push(zoneId: string, start: Vec2, dir: Vec2, speed: number) {
  const rules = rulesOf(zoneId);
  const { obstacles } = rules.collision!;
  let p = start;
  let server = start;
  let budget = freshBudget(0, rules);
  let before = p;
  const r = { entered: 0, corrections: 0, vibrations: 0, maxGap: 0 };
  for (let f = 0; f < 180; f++) {
    const prev = p;
    const to = { x: p.x + dir.x * speed * DT, z: p.z + dir.z * speed * DT };
    p = moveWithCollisions(p, to, R, obstacles, rules.bounds, SUB);
    if (isBlocked(p, R, obstacles)) r.entered++;
    // vibration : retour à la position d'il y a deux images après avoir bougé
    const moved = Math.hypot(p.x - prev.x, p.z - prev.z) > 1e-3;
    if (moved && Math.hypot(p.x - before.x, p.z - before.z) < 1e-3) r.vibrations++;
    before = prev;
    if (f % FRAMES_PER_SEND === FRAMES_PER_SEND - 1) {
      const v = validateMove(server, p, budget, (f + 1) * DT * 1000, rules);
      budget = v.budget;
      server = v.pos;
      r.maxGap = Math.max(r.maxGap, Math.hypot(server.x - p.x, server.z - p.z));
      if (v.corrected) {
        r.corrections++;
        p = v.pos;
      }
    }
  }
  return r;
}

describe('magasins : poussée contre comptoirs et rayons', () => {
  for (const zoneId of SHOPS) {
    const interior = gameData.interiors.get(zoneId)!;
    const { obstacles } = zoneArea(gameData, zoneId)!;
    for (const st of interior.stations.filter((s) => s.solid))
      it(`${zoneId}/${st.id} : 8 directions, marche et course, sans entrer, vibrer ni correction`, () => {
        for (const [k, dir] of DIRS.entries())
          for (const speed of [config.movement.walkSpeed, config.movement.runSpeed]) {
            // départ libre à ~2 m du poste, côté opposé à la poussée
            const start = { x: st.position.x - dir.x * 2, z: st.position.z - dir.z * 2 };
            const b = rulesOf(zoneId).bounds;
            const inRoom =
              start.x >= b.minX + R &&
              start.x <= b.maxX - R &&
              start.z >= b.minZ + R &&
              start.z <= b.maxZ - R;
            // départ hors de la salle (poste collé au mur) ou dans un autre poste : sans objet
            if (!inRoom || isBlocked(start, R, obstacles)) continue;
            const r = push(zoneId, start, dir, speed);
            const label = `direction ${k}, ${speed} m/s`;
            expect(r.entered, label).toBe(0);
            expect(r.vibrations, label).toBe(0);
            expect(r.corrections, label).toBe(0);
            expect(r.maxGap, label).toBeLessThanOrEqual(config.collision.correctionThreshold);
          }
      });
  }

  it('postes de paiement / dialogue : point d’interaction atteignable sans toucher le poste', () => {
    for (const zoneId of SHOPS) {
      const interior = gameData.interiors.get(zoneId)!;
      const { obstacles, bounds } = zoneArea(gameData, zoneId)!;
      const clear = R + config.collision.passageMargin;
      for (const st of interior.stations.filter((s) => s.solid && s.kind !== 'shelf')) {
        let found = false;
        for (let x = bounds.minX; x <= bounds.maxX && !found; x += 0.05)
          for (let z = bounds.minZ; z <= bounds.maxZ && !found; z += 0.05)
            if (
              Math.hypot(x - st.position.x, z - st.position.z) <= st.interactRadius &&
              !isBlocked({ x, z }, clear, obstacles)
            )
              found = true;
        expect(found, `${zoneId}/${st.id}`).toBe(true);
      }
    }
  });
});

describe('hystérésis du bouton ACTION et des panneaux', () => {
  const interior = gameData.interiors.get('shop')!;
  const counter = interior.stations.find((s) => s.kind === 'counter')!;
  const places = interiorPlaces(interior, []);
  // entre le rayon d'entrée et le rayon de sortie, sur l'axe du comptoir côté salle
  const between = {
    x: counter.position.x,
    z: counter.position.z + counter.interactRadius + EXIT / 2,
  };

  it('rayons d’entrée et de sortie distincts, sortie dans la tolérance du serveur', () => {
    expect(EXIT).toBeGreaterThan(0);
    expect(EXIT).toBeLessThanOrEqual(config.world.interactTolerance);
    expect(inInteractRange(between, counter, false, EXIT)).toBe(false);
    expect(inInteractRange(between, counter, true, EXIT)).toBe(true);
    const out = { x: between.x, z: counter.position.z + counter.interactRadius + EXIT * 1.1 };
    expect(inInteractRange(out, counter, true, EXIT)).toBe(false);
  });

  it('le poste visé reste choisi entre les deux rayons : le bouton ne clignote pas', () => {
    expect(stickyNearest(between, places, null, EXIT)?.id).not.toBe(counter.id);
    expect(stickyNearest(between, places, counter.id, EXIT)?.id).toBe(counter.id);
  });
});
